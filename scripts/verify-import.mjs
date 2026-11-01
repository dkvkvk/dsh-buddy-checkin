/**
 * 静态体检：从某个 DSH profile 目录出发，解析已安装的 dsh-buddy-checkin，
 * 真正 import 一次 host 半边并检查导出，同时打印 peer 范围与 profile 里的豁免记录。
 *
 * 用法：
 *   node scripts/verify-import.mjs                         # 默认 $DSH_HOME/profiles/desktop
 *   node scripts/verify-import.mjs "C:\path\to\profile"
 *
 * 注意：这里只证明「能解析、能导入、导出齐全」，**不证明宿主兼容闸门会放行**。
 * 闸门由宿主按自身 runtime 版本比 peer 范围（见 README 的说明）；本脚本把范围打印出来供肉眼核对。
 */
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const PKG = "dsh-buddy-checkin";

function defaultProfileDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(home, "profiles", "desktop");
}

const profileDir = path.resolve(process.argv[2] || defaultProfileDir());
if (!fs.existsSync(path.join(profileDir, "package.json"))) {
  console.error(`✗ profile 目录不像 DSH profile：${profileDir}`);
  process.exit(2);
}

const req = createRequire(pathToFileURL(path.join(profileDir, "package.json")));
let installedManifest;
try {
  installedManifest = req.resolve(`${PKG}/package.json`);
} catch (error) {
  console.error(`✗ 在 ${profileDir} 里解析不到 ${PKG}：${error.message}`);
  console.error("  先确认 dependencies 里有它、node_modules 已安装（pnpm install）。");
  process.exit(2);
}

const pkgDir = path.dirname(installedManifest);
const manifest = JSON.parse(fs.readFileSync(installedManifest, "utf8"));

console.log(`profile      : ${profileDir}`);
console.log(`installed at : ${pkgDir}`);
console.log(`version      : ${manifest.version}`);

const dshPeers = Object.entries(manifest.peerDependencies || {}).filter(
  ([name]) => name === "@deepseek-ai/dsh" || name.startsWith("@deepseek-ai/dsh-"),
);
console.log("dsh peer ranges:");
for (const [name, range] of dshPeers) console.log(`  ${name} -> ${range}`);

const compatibilityPath = path.join(profileDir, "compatibility.json");
const key = `${manifest.name}@${manifest.version}`;
if (fs.existsSync(compatibilityPath)) {
  try {
    const exemptions = JSON.parse(fs.readFileSync(compatibilityPath, "utf8"));
    const allowed = exemptions[key];
    console.log(
      `exemption    : ${allowed ? `${key} -> ${JSON.stringify(allowed)}` : `(无 ${key} 的记录)`}`,
    );
  } catch (error) {
    console.log(`exemption    : 读取 compatibility.json 失败：${error.message}`);
  }
} else {
  console.log("exemption    : (profile 里没有 compatibility.json)");
}

const mod = await import(pathToFileURL(path.join(pkgDir, "lib", "index.mjs")).href);
const keys = Object.keys(mod).sort();
const must = ["apply", "inject", "name"];
const missing = must.filter((name) => !keys.includes(name));
console.log(`exports      : ${keys.join(", ")}`);
if (missing.length > 0) {
  console.error(`✗ host 半边缺少关键导出：${missing.join(", ")}`);
  process.exit(1);
}
console.log(`inject       : ${JSON.stringify(mod.inject)}`);
console.log(`plugin name  : ${mod.name}`);
console.log("✓ 导入与导出检查通过（宿主闸门是否放行仍需重启后看面板或路由是否 200）");
