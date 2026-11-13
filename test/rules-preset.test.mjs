/**
 * 内置规则预设：结构化规则骨架
 *
 * 覆盖契约（lib/rules.js 里的 presets 段）：
 *   1) 预设注册表形状正确，数据文件在包内、大小在 256KB 上限内；
 *   2) 预设正文是「结构」而不是文案：含六段规则格式、分区表、四级阶梯；不含任何
 *      人设/渠道/引流类词（本文件用 String.fromCharCode 拼断言串，避免把敏感词写进仓库）；
 *   3) ensureBuiltinRulePresets 首次落盘 → listRules / rulesStatus 能列出（预设「存在且可列出」）；
 *   4) 幂等：二次初始化不动正文，使用者改过的内容不被覆盖；
 *   5) 删除后记账 skipped，不再复活；
 *   6) 落盘不激活：AGENTS.md 不变、state.json 不写；
 *   7) 与 $DSH_HOME/prompt-inject.md 互不影响（两条注入链相互独立）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const rules = await import("../lib/rules.js");
const core = await import("../lib/core.js");

const PRESET_ID = "structured-rules-skeleton";
const MAX_RULE_BYTES = 256 * 1024;

/** 断言串脱敏：仓库里不出现原始词，运行期还原成码点。 */
const U = (...codes) => String.fromCharCode(...codes);
const BANNED = {
  persona: U(0x5bcc, 0x6c5f), // 前任人设名
  kinship: U(0x7238, 0x7238), // 家属化称呼
  group: U(0x4ea4, 0x6d41, 0x7fa4), // 群
  qr: U(0x4e8c, 0x7ef4, 0x7801),
  contact: U(0x8054, 0x7cfb, 0x65b9, 0x5f0f),
  erotic: U(0x8272, 0x60c5),
  explicit: U(0x9732, 0x9aa8),
  official: U(0x5b98, 0x65b9),
  relay: U(0x4e2d, 0x8f6c, 0x7ad9),
  dumbed: U(0x964d, 0x667a),
  youAre: U(0x4f60, 0x662f),
  iAm: U(0x6211, 0x662f),
  handle: "@" + U(0x46, 0x4a, 0x4e, 0x42, 0x32, 0x32), // 旧推广 handle
};

function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-rules-preset-"));
}

function withHome(fn) {
  return async () => {
    const home = makeHome();
    try {
      await fn(home);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  };
}

function presetBody() {
  return rules.readBuiltinPresetBody(PRESET_ID);
}

// ---------------------------------------------------------------------------
// 1. 注册表
// ---------------------------------------------------------------------------

test("预设已注册：id 合法、目标在白名单、数据文件在包内", () => {
  assert.ok(Array.isArray(rules.BUILTIN_RULE_PRESETS));
  const preset = rules.BUILTIN_RULE_PRESETS.find((p) => p.id === PRESET_ID);
  assert.ok(preset, "结构化规则骨架必须在内置注册表里");
  assert.equal(rules.validRuleId(preset.id), true);
  assert.equal(preset.name, "结构化规则骨架");
  assert.ok(rules.RULE_TARGETS.includes(preset.target), "target 必须落在 RULE_TARGETS 内");
  assert.equal(rules.isBuiltinRuleId(PRESET_ID), true);
  assert.equal(rules.isBuiltinRuleId("not-a-builtin"), false);
  assert.equal(preset.file, `${preset.id}.md`, "数据文件名与 id 对齐");
  assert.equal(path.basename(rules.builtinPresetDir()), "rules", "数据目录是 presets/rules");
  assert.equal(path.basename(path.dirname(rules.builtinPresetDir())), "presets");
  assert.ok(fs.existsSync(path.join(rules.builtinPresetDir(), preset.file)));
  assert.equal(rules.builtinPreset(PRESET_ID).version, preset.version);
  assert.equal(rules.builtinPreset("nope"), null);
});

// ---------------------------------------------------------------------------
// 2. 正文：结构在、广告人设不在
// ---------------------------------------------------------------------------

test("预设正文：六段规则格式 + 分区表 + 四级阶梯都在", () => {
  const body = presetBody();
  assert.ok(body && body.trim().length > 0, "预设正文不能为空");
  assert.ok(Buffer.byteLength(body, "utf8") <= MAX_RULE_BYTES, "正文必须在 256KB 上限内");

  for (const heading of [
    "触发条件",
    "适用边界",
    "允许动作",
    "禁止动作",
    "兜底行为",
    "优先级",
  ]) {
    assert.ok(body.includes(heading), `缺少规则段：${heading}`);
  }
  for (const structural of ["分区组织", "Scoped Rules", "意图归一化", "仲裁", "自检清单"]) {
    assert.ok(body.includes(structural), `缺少结构小节：${structural}`);
  }
  for (const rung of ["L1 原理", "L2 机制", "L3 流程", "L4 实现"]) {
    assert.ok(body.includes(rung), `缺少阶梯档位：${rung}`);
  }
  // 分区表：D00–D10 至少 D01 与 D10 两行
  assert.ok(body.includes("D01") && body.includes("D10"), "分区表要带域标识");
});

test("预设正文脱敏：不含人设名、家属称呼、群/二维码/联系方式、推广渠道字样", () => {
  const body = presetBody();
  for (const [label, needle] of Object.entries(BANNED)) {
    assert.equal(body.includes(needle), false, `正文不得包含 ${label} 类字样`);
  }
  assert.equal(/(^|[^A-Za-z0-9])t[gG]([^A-Za-z0-9]|$)/.test(body), false, "不得出现群组平台缩写");
  assert.equal(/@[A-Za-z0-9_]{3,}/.test(body), false, "不得出现账号 handle");
  assert.equal(/https?:\/\//i.test(body), false, "不得出现链接");
  assert.equal(/\d{5,}/.test(body), false, "不得出现连续长数字（联系方式类）");
  assert.equal(/\b(?:qq|wechat|weixin|telegram)\b/i.test(body), false, "不得出现即时通信渠道名");
});

test("预设正文读不到时返回 null（打包裁剪可降级）", () => {
  assert.equal(rules.readBuiltinPresetBody("no-such-preset"), null);
});

// ---------------------------------------------------------------------------
// 3. 首次初始化：落盘 → 可列出
// ---------------------------------------------------------------------------

test(
  "首次初始化：预设落盘为 .md + .json，listRules 与 rulesStatus 都能列出",
  withHome(async (home) => {
    const init = await rules.ensureInitialState(home);
    assert.deepEqual(init.presets.installed, [PRESET_ID]);
    assert.equal(init.active, null, "落盘不等于激活");

    assert.ok(fs.existsSync(rules.rulePath(home, PRESET_ID)));
    assert.ok(fs.existsSync(rules.ruleMetaPath(home, PRESET_ID)));
    assert.equal(fs.readFileSync(rules.rulePath(home, PRESET_ID), "utf8"), presetBody());

    const meta = await rules.readRuleMeta(home, PRESET_ID);
    assert.deepEqual(meta, { name: "结构化规则骨架", target: "AGENTS.md" });

    const listed = await rules.listRules(home);
    const row = listed.find((r) => r.id === PRESET_ID);
    assert.ok(row, "listRules 必须列出内置预设");
    assert.equal(row.name, "结构化规则骨架");
    assert.equal(row.target, "AGENTS.md");
    assert.equal(row.size, Buffer.byteLength(presetBody(), "utf8"));

    const status = await rules.rulesStatus(home);
    assert.ok(status.rules.some((r) => r.id === PRESET_ID));
    assert.equal(status.rules_dir, rules.rulesDir(home));
    assert.equal(status.active, null);
    assert.equal(fs.existsSync(path.join(home, "AGENTS.md")), false, "初始化不得写 AGENTS.md");
    assert.equal(fs.existsSync(rules.stateFile(home)), false, "初始化不得写 state.json");
  }),
);

test(
  "状态记账：seeded 记录版本，且文件不落在规则正文目录之外",
  withHome(async (home) => {
    await rules.ensureInitialState(home);
    const state = rules.readBuiltinPresetState(home);
    assert.equal(state.seeded[PRESET_ID].version, rules.builtinPreset(PRESET_ID).version);
    assert.deepEqual(state.skipped, []);
    assert.equal(typeof state.seeded[PRESET_ID].at, "string");
  }),
);

// ---------------------------------------------------------------------------
// 4. 幂等 + 不覆盖用户改动
// ---------------------------------------------------------------------------

test(
  "幂等：二次初始化不重写正文，只报告 existing",
  withHome(async (home) => {
    await rules.ensureBuiltinRulePresets(home);
    const before = fs.readFileSync(rules.rulePath(home, PRESET_ID), "utf8");
    const beforeStat = fs.statSync(rules.rulePath(home, PRESET_ID));

    const again = await rules.ensureBuiltinRulePresets(home);
    assert.deepEqual(again.installed, []);
    assert.deepEqual(again.existing, [PRESET_ID]);

    const after = fs.readFileSync(rules.rulePath(home, PRESET_ID), "utf8");
    assert.equal(after, before, "二次初始化不得改动正文");
    assert.equal(fs.statSync(rules.rulePath(home, PRESET_ID)).mtimeMs, beforeStat.mtimeMs);
  }),
);

test(
  "不覆盖：使用者改过的预设正文保持原样，只补记 seeded",
  withHome(async (home) => {
    fs.mkdirSync(rules.rulesDir(home), { recursive: true });
    const mine = "# 我改过的规则\n\n- 触发条件：自定义\n";
    fs.writeFileSync(rules.rulePath(home, PRESET_ID), mine, "utf8");

    const res = await rules.ensureBuiltinRulePresets(home);
    assert.deepEqual(res.installed, []);
    assert.deepEqual(res.existing, [PRESET_ID]);
    assert.equal(fs.readFileSync(rules.rulePath(home, PRESET_ID), "utf8"), mine);
    assert.equal(rules.readBuiltinPresetState(home).seeded[PRESET_ID].version, 1);
  }),
);

// ---------------------------------------------------------------------------
// 5. 删除不复活
// ---------------------------------------------------------------------------

test(
  "删除后不复活：deleteRule 记 skipped，再初始化不再写回",
  withHome(async (home) => {
    await rules.ensureInitialState(home);
    await rules.deleteRule(home, PRESET_ID);
    assert.equal(fs.existsSync(rules.rulePath(home, PRESET_ID)), false);
    assert.ok(rules.readBuiltinPresetState(home).skipped.includes(PRESET_ID));

    const res = await rules.ensureBuiltinRulePresets(home);
    assert.deepEqual(res.skipped, [PRESET_ID]);
    assert.equal(fs.existsSync(rules.rulePath(home, PRESET_ID)), false, "删掉的预设不得被写回");
    assert.equal((await rules.listRules(home)).some((r) => r.id === PRESET_ID), false);
  }),
);

test(
  "从未落盘就删除：不记 skipped，后续初始化仍会安装",
  withHome(async (home) => {
    await rules.deleteRule(home, PRESET_ID);
    assert.deepEqual(rules.readBuiltinPresetState(home).skipped, []);
    const res = await rules.ensureBuiltinRulePresets(home);
    assert.deepEqual(res.installed, [PRESET_ID]);
  }),
);

// ---------------------------------------------------------------------------
// 6. 激活走既有机制
// ---------------------------------------------------------------------------

test(
  "激活：写入 AGENTS.md、active 指向预设、agents_synced 为真",
  withHome(async (home) => {
    await rules.ensureInitialState(home);
    const meta = await rules.activateRule(home, PRESET_ID);
    assert.deepEqual(meta, { name: "结构化规则骨架", target: "AGENTS.md" });
    assert.equal(await rules.readActive(home), PRESET_ID);
    assert.equal(fs.readFileSync(path.join(home, "AGENTS.md"), "utf8"), presetBody());

    const status = await rules.rulesStatus(home);
    assert.equal(status.active, PRESET_ID);
    assert.equal(status.active_target, "AGENTS.md");
    assert.equal(status.agents_exists, true);
    assert.equal(status.agents_synced, true);

    // 还原：目标文件回滚后 active 清空，规则库里的预设保留
    const reset = await rules.resetToOriginal(home);
    assert.deepEqual(reset.removed, [path.join(home, "AGENTS.md")]);
    assert.equal(await rules.readActive(home), null);
    assert.ok(fs.existsSync(rules.rulePath(home, PRESET_ID)), "还原不清空规则库");
  }),
);

// ---------------------------------------------------------------------------
// 7. 与 prompt-inject.md 相互独立
// ---------------------------------------------------------------------------

test(
  "独立性：预设不读不写 prompt-inject.md，激活后注入来源仍是用户文件",
  withHome(async (home) => {
    const userInject = "# USER-INJECT-SENTINEL\n\n用户自己的注入正文。\n";
    fs.writeFileSync(path.join(home, "prompt-inject.md"), userInject, "utf8");

    const init = await rules.ensureInitialState(home);
    assert.deepEqual(init.presets.installed, [PRESET_ID]);
    assert.equal(fs.readFileSync(path.join(home, "prompt-inject.md"), "utf8"), userInject);

    await rules.activateRule(home, PRESET_ID);
    assert.equal(fs.readFileSync(path.join(home, "prompt-inject.md"), "utf8"), userInject);

    const resolved = rules.resolveInjectText(home);
    assert.equal(resolved.source, "prompt");
    assert.equal(resolved.ruleId, null, "规则集不接管 system 注入链");
    assert.equal(resolved.text, userInject.trim());

    const status = await rules.rulesStatus(home);
    assert.equal(status.injectSource, "prompt");
    assert.equal(status.injectRuleId, null);
    // 规则正文与注入正文是两份不同的东西，不应互相包含
    assert.equal(presetBody().includes("USER-INJECT-SENTINEL"), false);
    assert.equal(fs.readFileSync(path.join(home, "AGENTS.md"), "utf8").includes("USER-INJECT-SENTINEL"), false);
  }),
);

test(
  "空 home：ensureInitialState 不造目录、不抛错",
  () => {
    const ghost = path.join(os.tmpdir(), "dsh-purge-ghost-home-does-not-exist");
    fs.rmSync(ghost, { recursive: true, force: true });
    return rules.ensureInitialState(ghost).then((r) => {
      assert.deepEqual(r.presets, { installed: [], existing: [], skipped: [], missing: [] });
      assert.equal(fs.existsSync(ghost), false, "home 不存在时不得顺手创建");
    });
  },
);

test(
  "core 侧依赖不变：RULE_TARGETS 与 resolveInjectText 行为未受影响",
  withHome(async (home) => {
    assert.deepEqual(rules.RULE_TARGETS, ["AGENTS.md", "CLAUDE.md"]);
    assert.equal(typeof core.normalizeOverride, "function");
    const resolved = rules.resolveInjectText(home);
    assert.ok(["none", "default", "prompt"].includes(resolved.source));
    assert.equal(resolved.ruleId, null);
  }),
);
