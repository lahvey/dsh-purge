import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMarket } from "../scripts/build-market.mjs";
const release = (version, extra = {}) => ({ tag_name: `v${version}`, published_at: "2026-10-18T00:00:00Z", assets: [{ name: `dsh-purge-community-${version}.tgz` }], ...extra });
const git = (args) => args[0] === "show" ? JSON.stringify({ name: "dsh-purge-community", version: args[1].split(":")[0].slice(1), dsh: { bundle: { patch: "./cordis.patch.yml" } } }) : "a".repeat(40);
test("market includes only published stable qualified bundles, pinned to complete commits", () => {
  const index = buildMarket([release("1.6.5"), release("1.6.4"), release("1.6.6", { draft: true }), release("1.6.7", { prerelease: true }), release("1.6.8", { assets: [] })], git);
  assert.equal(index.format, 1); assert.equal(index.plugins[0].versions.length, 1);
  assert.equal(index.plugins[0].versions[0].version, "1.6.5");
  assert.equal(index.plugins[0].versions[0].source.commit, "a".repeat(40));
  assert.equal(index.plugins[0].versions[0].publishTimestamp, 1792281600);
});
test("market fails rather than publishing an empty index, mismatched package or invalid commit", () => {
  assert.throws(() => buildMarket([], git), /No published/);
  assert.throws(() => buildMarket([release("1.6.5")], () => "{}"), /Invalid bundle/);
  assert.throws(() => buildMarket([release("1.6.5")], (args) => args[0] === "show" ? git(args) : "master"), /identity/);
});
test('each release uses its own declared compatibility; historical absence keeps narrow fallback',()=>{
 const read=args=>args[0]==='show'?JSON.stringify({name:'dsh-purge-community',version:args[1].split(':')[0].slice(1),dsh:{bundle:{},...(args[1].startsWith('v1.6.74:')?{compatibility:{dsh:'>=0.2.1-rc.1 <0.3.0'}}:{})}}):'b'.repeat(40);
 const versions=buildMarket([release('1.6.74'),release('1.6.5')],read).plugins[0].versions;
 assert.equal(versions.find(v=>v.version==='1.6.74').engines.dsh,'>=0.2.1-rc.1 <0.3.0');
 assert.equal(versions.find(v=>v.version==='1.6.5').engines.dsh,'>=0.2.1-rc.1 <0.2.2-0');
});

test("the install manifest pins the package archive to its own release tag", async () => {
  const {readFile} = await import("node:fs/promises");
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  // 社区版（lahvey fork）把 TGZ 发到 fork 的 release 上，镜像仓库必须认；
  // 但"名字 / 版本 / 标签 / 归档名"必须自洽，不能指向别家的发行包。
  const pinned = /^https:\/\/github\.com\/([^/]+)\/dsh-purge\/releases\/download\/v([^/]+)\/([\w.-]+)$/
    .exec(pkg.dsh.install.tarball || "");
  assert.ok(pinned, `tarball 必须是本仓库固定版本的 release 链接：${pkg.dsh.install.tarball}`);
  const [, owner, tag, archive] = pinned;
  assert.ok(["kingcharleslzy-ai", "lahvey"].includes(owner), `未知发布仓库：${owner}`);
  assert.equal(tag, pkg.version);
  assert.equal(archive, `${pkg.name}-${pkg.version}.tgz`);
});
