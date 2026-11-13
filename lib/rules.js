import fs, { promises as fsp } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  findDshHome,
  defaultOverrideText,
  hangOperatorPrompt,
  hungOperatorPrompt,
  normalizeOverride,
  peekCommittedOverride,
  readPromptInjectFileSync,
  hashOverride,
  defaultOverrideHash,
  atomicWriteFile,
  atomicCopyFile,
} from "./core.js";

const RULE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const MAX_RULE_BYTES = 256 * 1024;
const MAX_NAME_LENGTH = 64;
export const RULE_TARGETS = ["AGENTS.md", "CLAUDE.md"];
const BACKUP_SUFFIX = ".dsh-purge-rule.bak";

// CWD 规则:扫 cwd → projectRoot 范围内的工作区指令文件,给 UI 展示并允许勾选参与注入。
// 命中与 @deepseek-ai/dsh-agent-instructions 的默认候选保持一致。
const CWD_CANDIDATE_FILES = ["AGENTS.md", "CLAUDE.md", "AGENTS.local.md", "CLAUDE.local.md"];
const PROJECT_ROOT_MARKERS = [".git", ".hg", ".svn"];
export const WORKSPACE_POLICIES = ["fallback", "strict", "always"];
const DEFAULT_WORKSPACE_POLICY = "fallback";
const MAX_CWD_WALK_DEPTH = 32;
const MAX_LOCAL_INJECT_BYTES = 512 * 1024;

// ───────────────────────────────────────────────────────────────────────────
// 内置规则预设（builtin rule presets）
//
// 预设 = 随包发布的规则正文（只读，位于 presets/rules/），首次启动时"落盘"成
// 普通规则（$DSH_HOME/rules/<id>.md + <id>.json）。落盘之后它就是一条普通规则，
// 走既有的 listRules / rulesStatus / activateRule / deleteRule 通道，UI/CLI/HTTP
// 三条读口不需要任何改动。
//
// 四条不变量（下面每个函数都按这四条写，不要合并简化）：
//   1. 落盘 ≠ 激活：ensureBuiltinRulePresets 只写 $DSH_HOME/rules/，绝不写
//      AGENTS.md / CLAUDE.md / state.json；只有 activateRule 才会动目标文件。
//   2. 幂等：已落盘就不再产生写操作（正文 mtime 不变），状态文件内容没变也不写。
//   3. 不覆盖用户改动：目标 .md 已存在时只补记 seeded，正文原样保留——预设升级
//      也不静默替换正文。
//   4. 删除不复活：用户显式 deleteRule 掉的内置预设记进 skipped，后续初始化跳过；
//      从未落盘就删除的不记账，避免空 home 上误删把后续安装永久关掉。
//
// 与会话注入链的关系：规则正文走宿主的 workspace-instruction 通道（AGENTS.md），
// prompt-inject.md / 加密槽是另一条链（见 resolveInjectText）；这里两边都不碰。
// ───────────────────────────────────────────────────────────────────────────

/** 包内预设目录：<包根>/presets/rules（只读数据，不进 $DSH_HOME）。 */
const BUILTIN_PRESET_SOURCE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "presets",
  "rules",
);

/**
 * 落盘记账文件名。故意用 .json 而不是 .md：listRules 只收 .md，
 * 所以它不会被当成一条规则列出来。
 */
const BUILTIN_STATE_FILE = "_builtin-presets.json";

/** 内置预设注册表。新增预设只加一行；正文放 presets/rules/<id>.md。 */
export const BUILTIN_RULE_PRESETS = [
  {
    id: "structured-rules-skeleton",
    name: "结构化规则骨架",
    target: "AGENTS.md",
    version: 1,
    file: "structured-rules-skeleton.md",
  },
];

/** 内置预设的只读数据目录（测试与后续 UI 用）。 */
export function builtinPresetDir() {
  return BUILTIN_PRESET_SOURCE_DIR;
}

/** id 是否属于内置预设（不要求已落盘或正文存在）。 */
export function isBuiltinRuleId(id) {
  return BUILTIN_RULE_PRESETS.some((p) => p.id === id);
}

/** 取内置预设元数据；未注册返回 null。 */
export function builtinPreset(id) {
  return BUILTIN_RULE_PRESETS.find((p) => p.id === id) || null;
}

/**
 * 读包内预设正文。文件缺失/为空返回 null 而不是抛错：
 * 打包裁剪（或 --omit 掉 presets）时降级成"没有预设"，不影响别的规则。
 */
export function readBuiltinPresetBody(id) {
  const preset = builtinPreset(id);
  if (!preset) return null;
  try {
    const body = fs.readFileSync(path.join(builtinPresetDir(), preset.file), "utf8");
    return body && body.trim() ? body : null;
  } catch {
    return null;
  }
}

/** $DSH_HOME/rules/_builtin-presets.json：{seeded:{<id>:{version,at}}, skipped:[<id>]} */
function builtinStatePath(dshHome) {
  return path.join(rulesDir(dshHome), BUILTIN_STATE_FILE);
}

/** 读记账状态；坏文件按空状态处理（宁可多落一次盘，也不因坏 json 卡住启动）。 */
export function readBuiltinPresetState(dshHome) {
  const empty = { seeded: {}, skipped: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(builtinStatePath(dshHome), "utf8"));
    const seeded = {};
    for (const [id, rec] of Object.entries(parsed?.seeded || {})) {
      if (!validRuleId(id) || !rec || typeof rec !== "object") continue;
      seeded[id] = {
        version: Number.isFinite(rec.version) ? rec.version : 0,
        at: typeof rec.at === "string" ? rec.at : "",
      };
    }
    const skipped = [];
    for (const id of Array.isArray(parsed?.skipped) ? parsed.skipped : []) {
      if (validRuleId(id) && !skipped.includes(id)) skipped.push(id);
    }
    return { seeded, skipped };
  } catch {
    return empty;
  }
}

function serializeBuiltinState(state) {
  const seeded = {};
  for (const id of Object.keys(state.seeded).sort()) seeded[id] = state.seeded[id];
  return JSON.stringify({ seeded, skipped: [...state.skipped].sort() }, null, 2);
}

/** 原子写记账状态；内容没变就完全不碰磁盘（幂等不变量 2）。 */
async function writeBuiltinPresetState(dshHome, state) {
  const fp = builtinStatePath(dshHome);
  const next = serializeBuiltinState(state);
  let prev = null;
  try {
    prev = await fsp.readFile(fp, "utf8");
  } catch {
    // 首次落盘
  }
  if (prev === next) return false;
  await fsp.mkdir(rulesDir(dshHome), { recursive: true });
  await atomicWriteFile(fp, next);
  return true;
}

/**
 * 幂等落盘内置预设。返回 {installed, existing, skipped, missing}：
 *   installed 本次写入的 / existing 已存在（跳过）/ skipped 用户删过（跳过）
 *   / missing 包内正文缺失（降级）。
 */
export async function ensureBuiltinRulePresets(dshHome) {
  const result = { installed: [], existing: [], skipped: [], missing: [] };
  const home = typeof dshHome === "string" ? dshHome.trim() : "";
  // 不变量 1 的延伸：$DSH_HOME 不存在时不顺手造目录，空 home 原样留空。
  if (!home) return result;
  try {
    if (!(await fsp.stat(home)).isDirectory()) return result;
  } catch {
    return result;
  }

  const state = readBuiltinPresetState(home);
  const stamp = new Date().toISOString();
  let dirty = false;

  for (const preset of BUILTIN_RULE_PRESETS) {
    // 不变量 4：用户删过的不复活
    if (state.skipped.includes(preset.id)) {
      result.skipped.push(preset.id);
      continue;
    }
    const body = readBuiltinPresetBody(preset.id);
    if (body === null) {
      result.missing.push(preset.id);
      continue;
    }

    let existed = true;
    try {
      await fsp.stat(rulePath(home, preset.id));
    } catch {
      existed = false;
    }

    if (existed) {
      // 不变量 3：正文已存在就不写（用户可能改过），只补记 seeded
      result.existing.push(preset.id);
    } else {
      // 不变量 1：只写规则库，不碰 AGENTS.md / CLAUDE.md / state.json
      await fsp.mkdir(rulesDir(home), { recursive: true });
      await atomicWriteFile(rulePath(home, preset.id), body);
      await writeRuleMeta(home, preset.id, { name: preset.name, target: preset.target });
      result.installed.push(preset.id);
    }

    const prev = state.seeded[preset.id];
    if (!prev || prev.version !== preset.version) {
      // 升级只记版本号，正文交给使用者决定（不静默覆盖，见不变量 3）
      state.seeded[preset.id] = { version: preset.version, at: stamp };
      dirty = true;
    }
  }

  if (dirty) await writeBuiltinPresetState(home, state);
  return result;
}

/** 删除内置预设后记账，防止下次启动复活（不变量 4）。 */
export async function markBuiltinPresetSkipped(dshHome, id) {
  if (!isBuiltinRuleId(id)) return false;
  const home = typeof dshHome === "string" ? dshHome.trim() : "";
  if (!home) return false;
  const state = readBuiltinPresetState(home);
  if (state.skipped.includes(id)) return false;
  state.skipped.push(id);
  await writeBuiltinPresetState(home, state);
  return true;
}

export { findDshHome };

function purgeStateDir(dshHome) {
  return path.join(dshHome, "dsh-purge");
}

function cwdSelectionsPath(dshHome) {
  return path.join(purgeStateDir(dshHome), "cwd-selections.json");
}

function workspacePolicyPath(dshHome) {
  return path.join(purgeStateDir(dshHome), "workspace-policy.json");
}

function lastCwdPath(dshHome) {
  return path.join(purgeStateDir(dshHome), "last-cwd.txt");
}

export function rulesDir(dshHome) {
  return path.join(dshHome, "rules");
}

export function stateFile(dshHome) {
  return path.join(rulesDir(dshHome), "state.json");
}

export function rulePath(dshHome, id) {
  return path.join(rulesDir(dshHome), id + ".md");
}

export function ruleMetaPath(dshHome, id) {
  return path.join(rulesDir(dshHome), id + ".json");
}

export function validRuleId(id) {
  return typeof id === "string" && RULE_ID_RE.test(id);
}

export function validTarget(target) {
  return typeof target === "string" && RULE_TARGETS.includes(target);
}

export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return `${kb >= 100 ? Math.round(kb) : kb.toFixed(1)} KB`;
}

export function targetPath(dshHome, target) {
  if (!validTarget(target)) throw new Error(`invalid target: ${target}`);
  return path.join(dshHome, target);
}

export function normalizeMeta(id, meta) {
  const name =
    typeof meta?.name === "string" && meta.name.trim()
      ? meta.name.trim().slice(0, MAX_NAME_LENGTH)
      : id;
  const target = validTarget(meta?.target) ? meta.target : "AGENTS.md";
  return { name, target };
}

export async function readRuleMeta(dshHome, id) {
  try {
    const parsed = JSON.parse(await fsp.readFile(ruleMetaPath(dshHome, id), "utf8"));
    return normalizeMeta(id, parsed);
  } catch {
    return normalizeMeta(id, null);
  }
}

export async function writeRuleMeta(dshHome, id, meta) {
  if (!validRuleId(id)) throw new Error(`invalid rule id: ${id}`);
  await fsp.mkdir(rulesDir(dshHome), { recursive: true });
  await atomicWriteFile(ruleMetaPath(dshHome, id), JSON.stringify(normalizeMeta(id, meta), null, 2));
}

function readRuleContentSync(dshHome, id) {
  try {
    return fs.readFileSync(rulePath(dshHome, id), "utf8");
  } catch {
    return null;
  }
}

async function collectRuleContents(dshHome) {
  const listed = await listRules(dshHome);
  const contents = new Set();
  for (const r of listed) {
    const c = readRuleContentSync(dshHome, r.id);
    if (c !== null) contents.add(c);
  }
  return contents;
}

export async function listRules(dshHome) {
  const dir = rulesDir(dshHome);
  const out = [];
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".md")) continue;
      const id = e.name.slice(0, -3);
      if (!validRuleId(id)) continue;
      let size = 0;
      try {
        size = (await fsp.stat(path.join(dir, e.name))).size;
      } catch {
      }
      const meta = await readRuleMeta(dshHome, id);
      out.push({ id, name: meta.name, target: meta.target, size });
    }
  } catch {
    // rules 目录不存在时按空列表返回
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

export async function readRule(dshHome, id) {
  if (!validRuleId(id)) throw new Error(`invalid rule id: ${id}`);
  try {
    return await fsp.readFile(rulePath(dshHome, id), "utf8");
  } catch {
    return null;
  }
}

export async function saveRule(dshHome, id, content, meta) {
  if (!validRuleId(id)) throw new Error(`invalid rule id: ${id}`);
  if (Buffer.byteLength(content, "utf8") > MAX_RULE_BYTES) {
    throw new Error("rule too large (max 256KB)");
  }
  await fsp.mkdir(rulesDir(dshHome), { recursive: true });

  const rulePathStr = rulePath(dshHome, id);
  const metaPathStr = ruleMetaPath(dshHome, id);
  let prevRule = null;
  let prevMeta = null;
  try { prevRule = await fsp.readFile(rulePathStr, "utf8"); } catch { /* 新 rule */ }
  try { prevMeta = await fsp.readFile(metaPathStr, "utf8"); } catch { /* 新 rule */ }

  let wroteRule = false;
  let wroteMeta = false;
  try {
    await atomicWriteFile(rulePathStr, content);
    wroteRule = true;
    await writeRuleMeta(dshHome, id, meta);
    wroteMeta = true;
    if ((await readActive(dshHome)) === id) {
      await activateRule(dshHome, id);
    }
  } catch (e) {
    if (wroteRule) {
      try {
        if (prevRule === null) {
          await fsp.unlink(rulePathStr).catch(() => {});
        } else {
          await atomicWriteFile(rulePathStr, prevRule);
        }
      } catch { /* 回滚失败,原错继续抛 */ }
    }
    if (wroteMeta && prevMeta !== null) {
      try { await atomicWriteFile(metaPathStr, prevMeta); } catch { /* ignore */ }
    } else if (wroteMeta && prevMeta === null) {
      try { await fsp.unlink(metaPathStr).catch(() => {}); } catch { /* ignore */ }
    }
    throw e;
  }
}

export async function deleteRule(dshHome, id) {
  if (!validRuleId(id)) throw new Error(`invalid rule id: ${id}`);
  // 删除前先探测是否真的存在：只有"确实落盘过的内置预设"才记账 skipped，
  // 否则在空 home 上删一个从未落盘的预设会把后续安装永久关掉（不变量 4 的边界）。
  let existed = true;
  try {
    await fsp.stat(rulePath(dshHome, id));
  } catch {
    existed = false;
  }
  try {
    await fsp.unlink(rulePath(dshHome, id));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  try {
    await fsp.unlink(ruleMetaPath(dshHome, id));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  if (existed && isBuiltinRuleId(id)) {
    try {
      await markBuiltinPresetSkipped(dshHome, id);
    } catch {
      // 记账失败不阻断删除：下次启动会重新落盘，但规则已经删掉了
    }
  }
  if ((await readActive(dshHome)) === id) {
    try {
      await fsp.unlink(stateFile(dshHome));
    } catch {
    }
  }
}

export async function readActive(dshHome) {
  try {
    const parsed = JSON.parse(await fsp.readFile(stateFile(dshHome), "utf8"));
    return typeof parsed?.active === "string" && validRuleId(parsed.active) ? parsed.active : null;
  } catch {
    return null;
  }
}

export async function setActive(dshHome, id) {
  if (!validRuleId(id)) throw new Error(`invalid rule id: ${id}`);
  await fsp.mkdir(rulesDir(dshHome), { recursive: true });
  await fsp.writeFile(stateFile(dshHome), JSON.stringify({ active: id }, null, 2), "utf8");
}

/**
 * 本进程框内提交 > $DSH_HOME/prompt-inject.md > 加密槽。
 * 规则集只改 agents 目标文件，不参与 system 注入链（#74 磁盘与 UI/注入一致）。
 */
export function resolveInjectText(dshHome) {
  const home = path.normalize(String(dshHome || findDshHome() || ""));
  const pinned = peekCommittedOverride(home);
  if (typeof pinned === "string" && normalizeOverride(pinned)) {
    return { text: normalizeOverride(pinned), source: "prompt", ruleId: null };
  }
  const diskNorm = normalizeOverride(readPromptInjectFileSync(home));
  if (diskNorm) {
    const source = hashOverride(diskNorm) === defaultOverrideHash() ? "default" : "prompt";
    return { text: diskNorm, source, ruleId: null };
  }
  const bundled = normalizeOverride(defaultOverrideText());
  if (bundled) return { text: bundled, source: "default", ruleId: null };
  return { text: "", source: "none", ruleId: null };
}

/** 组装前挂上操作者正文（prompt-inject.md / 框内提交 / 加密槽）。 */
export function ensureOperatorBody(dshHome) {
  const resolved = resolveInjectText(dshHome);
  if (resolved.text) hangOperatorPrompt(resolved.text);
  return resolved.text || normalizeOverride(hungOperatorPrompt()) || "";
}

export async function activateRule(dshHome, id) {
  const content = await readRule(dshHome, id);
  if (content === null) throw new Error(`rule not found: ${id}`);
  const meta = await readRuleMeta(dshHome, id);
  const target = targetPath(dshHome, meta.target);
  const backup = `${target}${BACKUP_SUFFIX}`;
  if (!fs.existsSync(backup)) {
    try {
      const existing = await fsp.readFile(target, "utf8");
      const ruleContents = await collectRuleContents(dshHome);
      if (!ruleContents.has(existing)) {
        await atomicCopyFile(target, backup);
      }
    } catch { /* target 不存在 → 无需备份 */ }
  }
  await atomicWriteFile(target, content);
  await setActive(dshHome, id);
  return meta;
}

export async function ensureInitialState(dshHome) {
  // 顺序不可反：先把内置预铺设进规则库，再校验 active。反过来则首次安装时
  // active 指向尚未落盘的预设会被当成"规则文件不存在"而误清。
  const presets = await ensureBuiltinRulePresets(dshHome);
  const listed = await listRules(dshHome);
  let active = await readActive(dshHome);
  if (active !== null && !listed.some((r) => r.id === active)) {
    try {
      await fsp.unlink(stateFile(dshHome));
    } catch {
    }
    active = null;
  }
  return { active, presets };
}

export async function resetToOriginal(dshHome) {
  const active = await readActive(dshHome);
  const removed = [];
  const skipped = [];
  const restored = [];

  for (const target of RULE_TARGETS) {
    const fp = targetPath(dshHome, target);
    const bak = `${fp}${BACKUP_SUFFIX}`;
    if (!fs.existsSync(bak)) continue;
    try {
      await atomicCopyFile(bak, fp);
      await fsp.unlink(bak);
      restored.push(fp);
    } catch { /* restore 失败,fall through 到老逻辑 */ }
  }

  if (active !== null) {
    const meta = await readRuleMeta(dshHome, active);
    const fp = targetPath(dshHome, meta.target);
    if (!restored.includes(fp)) {
      const ruleContent = await readRule(dshHome, active);
      try {
        const fileContent = await fsp.readFile(fp, "utf8");
        if (ruleContent !== null && fileContent === ruleContent) {
          await fsp.unlink(fp);
          removed.push(fp);
        } else {
          skipped.push(fp);
        }
      } catch {
      }
    }
  }
  try {
    await fsp.unlink(stateFile(dshHome));
  } catch {
  }
  return { removed, skipped, restored };
}

export async function rulesStatus(dshHome, cwdHint) {
  const listed = await listRules(dshHome);
  const active = await readActive(dshHome);
  let active_target = null;
  let agents_exists = false;
  let agents_synced = false;
  let agents_path = targetPath(dshHome, "AGENTS.md");
  if (active !== null) {
    const meta = await readRuleMeta(dshHome, active);
    active_target = meta.target;
    agents_path = targetPath(dshHome, meta.target);
    try {
      const content = await fsp.readFile(agents_path, "utf8");
      agents_exists = true;
      const ruleContent = await readRule(dshHome, active);
      agents_synced = ruleContent !== null && ruleContent === content;
    } catch {
    }
  }
  const inject = resolveInjectText(dshHome);
  const cwd = pickCwd(dshHome, cwdHint);
  const cwdCandidates = cwd ? scanCwdInstructions(cwd) : [];
  const selections = readCwdSelections(dshHome);
  const workspacePolicy = readWorkspacePolicy(dshHome);
  return {
    rules: listed,
    active,
    injectSource: inject.source,
    injectRuleId: inject.ruleId,
    active_target,
    agents_exists,
    agents_synced,
    agents_path,
    rules_dir: rulesDir(dshHome),
    cwd,
    cwd_candidates: cwdCandidates.map((item) => ({
      ...item,
      selected: selections.includes(item.path),
    })),
    cwd_selections: selections,
    workspace_policy: workspacePolicy,
    workspace_policies: [...WORKSPACE_POLICIES],
  };
}

function pickCwd(dshHome, cwdHint) {
  const hint = typeof cwdHint === "string" ? cwdHint.trim() : "";
  if (hint) return path.resolve(hint);
  const last = readLastCwd(dshHome);
  return last ? path.resolve(last) : "";
}

/**
 * 向上走若干层,把 cwd 自身也算一层;遇到 .git/.hg/.svn 这类根标记就停住。
 * dsh-agent-instructions 的 findProjectRoot 用类似做法。没找到 root 就只扫 cwd 这一层。
 */
export function ancestorChainForCwd(cwd) {
  if (!cwd) return [];
  const normalized = path.resolve(cwd);
  let root = null;
  let cur = normalized;
  for (let i = 0; i < MAX_CWD_WALK_DEPTH; i += 1) {
    for (const marker of PROJECT_ROOT_MARKERS) {
      try {
        if (fs.existsSync(path.join(cur, marker))) { root = cur; break; }
      } catch { /* ignore */ }
    }
    if (root) break;
    const parent = path.dirname(cur);
    if (!parent || parent === cur) break;
    cur = parent;
  }
  const chain = [];
  const pushed = new Set();
  const stopAt = root ? path.resolve(root) : normalized;
  let walker = normalized;
  for (let i = 0; i < MAX_CWD_WALK_DEPTH; i += 1) {
    if (!pushed.has(walker)) { chain.push(walker); pushed.add(walker); }
    if (walker === stopAt) break;
    const parent = path.dirname(walker);
    if (!parent || parent === walker) break;
    walker = parent;
  }
  return chain.reverse();
}

export function scanCwdInstructions(cwd) {
  const out = [];
  if (!cwd) return out;
  const chain = ancestorChainForCwd(cwd);
  const seen = new Set();
  const leaf = path.resolve(cwd);
  for (const dir of chain) {
    for (const name of CWD_CANDIDATE_FILES) {
      const fp = path.join(dir, name);
      if (seen.has(fp)) continue;
      let stat = null;
      try { stat = fs.statSync(fp); } catch { continue; }
      if (!stat.isFile()) continue;
      seen.add(fp);
      let preview = "";
      try {
        const raw = fs.readFileSync(fp, "utf8");
        preview = raw.replace(/\s+/g, " ").trim().slice(0, 160);
      } catch { /* ignore */ }
      const scope = dir === leaf ? "cwd" : (dir === chain[0] ? "root" : "ancestor");
      out.push({
        path: fp,
        name,
        dir,
        scope,
        size: stat.size,
        mtime: stat.mtimeMs || stat.mtime?.getTime?.() || 0,
        preview,
      });
    }
  }
  return out;
}

export function readWorkspacePolicy(dshHome) {
  try {
    const parsed = JSON.parse(fs.readFileSync(workspacePolicyPath(dshHome), "utf8"));
    const policy = parsed?.policy;
    if (typeof policy === "string" && WORKSPACE_POLICIES.includes(policy)) return policy;
  } catch { /* ignore */ }
  return DEFAULT_WORKSPACE_POLICY;
}

export async function writeWorkspacePolicy(dshHome, policy) {
  if (!WORKSPACE_POLICIES.includes(policy)) {
    throw new Error(`invalid workspace policy: ${policy}`);
  }
  const fp = workspacePolicyPath(dshHome);
  await fsp.mkdir(path.dirname(fp), { recursive: true });
  await atomicWriteFile(fp, JSON.stringify({ policy }, null, 2));
  return policy;
}

function normalizeSelectionList(input) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(input) ? input : []) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const abs = path.resolve(trimmed);
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out;
}

export function readCwdSelections(dshHome) {
  try {
    const parsed = JSON.parse(fs.readFileSync(cwdSelectionsPath(dshHome), "utf8"));
    return normalizeSelectionList(parsed?.paths);
  } catch { return []; }
}

export async function writeCwdSelections(dshHome, paths) {
  const unique = normalizeSelectionList(paths);
  const fp = cwdSelectionsPath(dshHome);
  await fsp.mkdir(path.dirname(fp), { recursive: true });
  await atomicWriteFile(fp, JSON.stringify({ paths: unique }, null, 2));
  return unique;
}

export async function toggleCwdSelection(dshHome, filePath, enabled) {
  if (typeof filePath !== "string" || !filePath.trim()) throw new Error("invalid file path");
  const abs = path.resolve(filePath.trim());
  const current = readCwdSelections(dshHome);
  const set = new Set(current);
  if (enabled) set.add(abs); else set.delete(abs);
  return writeCwdSelections(dshHome, Array.from(set));
}

export function readLastCwd(dshHome) {
  try {
    const txt = fs.readFileSync(lastCwdPath(dshHome), "utf8").trim();
    return txt || "";
  } catch { return ""; }
}

export function writeLastCwd(dshHome, cwd) {
  if (typeof cwd !== "string" || !cwd.trim()) return;
  try {
    const fp = lastCwdPath(dshHome);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, cwd.trim(), "utf8");
  } catch { /* ignore */ }
}

/**
 * 返回勾选的本地指令文件拼接内容。仅当文件仍在当前 cwd 的扫描结果里才会被用上,
 * 避免切换目录后旧勾选跨目录穿越注入;超出 512KB 的内容会被截断。
 */
export function readSelectedCwdInject(dshHome, cwd) {
  const selections = readCwdSelections(dshHome);
  if (selections.length === 0) return "";
  const candidates = cwd ? scanCwdInstructions(cwd) : [];
  const candidateSet = new Set(candidates.map((c) => c.path));
  const chosen = selections.filter((p) => candidateSet.has(p));
  if (chosen.length === 0) return "";
  const parts = [];
  let total = 0;
  for (const fp of chosen) {
    let text = "";
    try {
      text = fs.readFileSync(fp, "utf8").trim();
    } catch { continue; }
    if (!text) continue;
    const header = `<!-- dsh-purge:cwd-rule ${path.basename(fp)} -->`;
    const block = `${header}\n${text}`;
    total += Buffer.byteLength(block, "utf8");
    if (total > MAX_LOCAL_INJECT_BYTES) break;
    parts.push(block);
  }
  return parts.join("\n\n---\n\n");
}
