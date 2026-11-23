#!/usr/bin/env node
/**
 * 社区版（lahvey fork）版本推进。
 *
 * 上游的 `scripts/check-docs.mjs` 要求「package.json 版本 / release-notes 首行 /
 * README 首屏 / 英文 README / 维护与安装文档 / AGENTS.md §9」全部指向同一版本，
 * 而 `.github/workflows/version-bump.yml` 只改 package.json 就会让这几项立刻过期。
 * 本脚本把这些表面一次改完，供工作流和本地手动 bump 共用：
 *
 *   node scripts/bump-fork-version.mjs 1.7.20-lahvey.2
 *
 * 只改版本号与指向本版的位置，不动历史版本记录和发行说明正文。
 */
import fs from 'node:fs'

const next = process.argv[2]
if (!/^\d+\.\d+\.\d+(?:-lahvey\.\d+)?$/.test(next || '')) {
  console.error('用法：node scripts/bump-fork-version.mjs X.Y.Z[-lahvey.N]')
  process.exit(1)
}

const pkgPath = 'package.json'
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
const previous = pkg.version
if (previous === next) {
  console.log(`版本已是 ${next}，无需改动`)
  process.exit(0)
}

/** 把版本表面改到 next；找不到锚点就报错，避免"改了半截"却静默通过。 */
function patch(file, edits) {
  let text = fs.readFileSync(file, 'utf8')
  for (const [pattern, replacement, label] of edits) {
    if (!pattern.test(text)) throw Error(`${file} 缺少可改的位置：${label}`)
    text = text.replace(pattern, replacement)
  }
  fs.writeFileSync(file, text)
}

const tarball = `https://github.com/lahvey/dsh-purge/releases/download/v${next}/dsh-purge-community-${next}.tgz`

// 1) package.json：版本 + 固定版本 TGZ（上游 test/market.test.mjs 校验两者一致）
pkg.version = next
pkg.dsh.install.tarball = tarball
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')

// 1b) package-lock.json 的根包版本跟着走，免得 lock 与 manifest 打架
if (fs.existsSync('package-lock.json')) {
  const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'))
  if (lock.packages?.['']) {
    lock.version = next
    lock.packages[''].version = next
    fs.writeFileSync('package-lock.json', JSON.stringify(lock, null, 2) + '\n')
  }
}

// 2) 中文 README（README.zh-CN.md 必须与 README.md 完全一致）
const readme = fs.readFileSync('README.md', 'utf8')
patch('README.md', [
  [/当前版本 \*\*[^\s*]+\*\*/, `当前版本 **${next}**`, '首屏当前版本'],
  [/releases\/download\/v[^\s/]+\/dsh-purge-community-[^\s"]+\.tgz/g, tarball, 'CLI 安装 TGZ 链接'],
])
fs.writeFileSync('README.zh-CN.md', fs.readFileSync('README.md', 'utf8'))

// 3) 英文 README
patch('docs/README.en.md', [
  [/Current version [^\s]+/, `Current version ${next}`, 'Current version 行'],
  [/releases\/download\/v[^\s/]+\/dsh-purge-community-[^\s"]+\.tgz/g, tarball, 'CLI 安装 TGZ 链接'],
])

// 4) 维护与安装文档
for (const file of ['docs/MAINTENANCE.md', 'docs/INSTALLATION.md']) {
  patch(file, [[/当前版本 \*\*[^\s*]+\*\*/, `当前版本 **${next}**`, '当前版本行']])
}

// 5) AGENTS.md：抬头版本 + §9 版本表
patch('AGENTS.md', [
  [/当前版本：\*\*[^*]+\*\*/, `当前版本：**${next}**`, 'AGENTS 抬头版本'],
  [/`dsh-purge-community` [0-9][^\s|]*/, `\`dsh-purge-community\` ${next}`, '§9 版本表'],
])

// 6) release-notes 首行必须等于版本；补一段没有正文改动说明
const notes = fs.readFileSync('release-notes.md', 'utf8')
if (!notes.startsWith(`# ${next}\n`)) {
  fs.writeFileSync(
    'release-notes.md',
    `# ${next}\n\n- 版本推进：与上一版同一提交集，仅同步版本号与固定版本安装链接，无功能改动。\n\n` + notes,
  )
}

// 7) check-docs 要求 docs/releases/<version>.md 存在且首行为版本号
const summary = `docs/releases/${next}.md`
if (!fs.existsSync(summary)) {
  fs.writeFileSync(
    summary,
    `# ${next}\n\n## 这一版做了什么\n\n- 版本推进到 \`${next}\`：与上一版同一提交集，只同步版本号、固定版本 TGZ 链接与文档版本行。\n- 功能与补丁表未改动；升级后重启 DSH 一次即可。\n\n## 已知限制\n\n- 本仓库不带自动发行流水线，固定版本 TGZ 由本机 \`npm pack\` 产出。\n`,
  )
}

console.log(`版本 ${previous} → ${next}：package.json、README（中/英）、维护/安装文档、AGENTS.md、release-notes 与发行摘要已同步`)
