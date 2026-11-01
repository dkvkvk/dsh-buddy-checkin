/**
 * 把本仓库打包成 tarball 并装进 DSH profile。
 *
 * 用法：
 *   node scripts/install-into-profile.mjs                 # 默认 desktop profile
 *   node scripts/install-into-profile.mjs --dry-run
 *   node scripts/install-into-profile.mjs <profileDir>
 *
 * 为什么用 file:<tarball> 而不是 link:（沿用 dsh-workbuddy-connect 分支 2026-10-29 的踩坑结论）：
 *   link: 只是把 node_modules/<pkg> 指向本仓库，Node 解析包内裸导入时会从**真实路径**逐级上溯，
 *   命中不到 profile 的 @deepseek-ai 树，宿主会静默跳过该 bundle（路由 404、日志无报错）。
 *   本插件的 host 半边目前只 import node 内置模块，link: 侥幸可用；但为与另一分支保持同一套
 *   安装方式、且给将来引入宿主包留余地，这里统一走 tarball。
 *
 * 做的事：
 *   1. pnpm pack（或 npm pack）出 tgz 到 dist/
 *   2. 备份 <profile>/package.json 与 pnpm-lock.yaml（带时间戳）
 *   3. dependencies["dsh-buddy-checkin"] = "file:<tgz 绝对路径>"
 *   4. dsh.profile.bundles 里补包名（不是 cordis.patch.yml 里的 insert id `buddy-checkin`）
 *   5. 用宿主自带 pnpm 在 profile 目录 install
 *   6. 跑一遍静态体检
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const PKG = "dsh-buddy-checkin";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const explicit = args.find((value) => !value.startsWith("--"));

const dshHome = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const profileDir = path.resolve(explicit || path.join(dshHome, "profiles", "desktop"));
const pkgPath = path.join(profileDir, "package.json");
const lockPath = path.join(profileDir, "pnpm-lock.yaml");

if (!fs.existsSync(pkgPath)) {
  console.error(`✗ 找不到 ${pkgPath}`);
  process.exit(2);
}

const pnpmCandidates = [
  "D:\\DeepSeek Harness\\resources\\runtime\\primary-runtime\\dependencies\\pnpm\\bin\\pnpm.cjs",
  "D:\\DeepSeek Harness\\resources\\runtime\\pnpm\\bin\\pnpm.cjs",
  path.join(process.env.APPDATA || "", "npm", "node_modules", "pnpm", "bin", "pnpm.cjs"),
];
const pnpm = pnpmCandidates.find((candidate) => candidate && fs.existsSync(candidate));

function runPnpm(argv, options = {}) {
  if (pnpm) return spawnSync(process.execPath, [pnpm, ...argv], { stdio: "inherit", ...options });
  return spawnSync("pnpm", argv, { stdio: "inherit", shell: true, ...options });
}

const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const distDir = path.join(repoRoot, "dist");
fs.mkdirSync(distDir, { recursive: true });

console.log(`repo         : ${repoRoot}`);
console.log(`package      : ${PKG}@${manifest.version}`);
console.log(`profile      : ${profileDir}`);
console.log(`pnpm         : ${pnpm ?? "(PATH 里的 pnpm)"}`);
console.log(`mode         : ${dryRun ? "dry-run" : "apply"}`);
if (dryRun) {
  console.log("--dry-run：不打包、不写文件、不 install。");
}

const backup = (file) => {
  if (!fs.existsSync(file)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = `${file}.bak-${stamp}`;
  fs.copyFileSync(file, target);
  console.log(`backup       : ${target}`);
};

if (!dryRun) {
  backup(pkgPath);
  backup(lockPath);

  const pack = runPnpm(["pack", "--pack-destination", distDir], { cwd: repoRoot, stdio: "inherit" });
  if (pack.status !== 0) {
    console.error("✗ pnpm pack 失败");
    process.exit(1);
  }
  const tgz = fs
    .readdirSync(distDir)
    .filter((name) => name.endsWith(".tgz"))
    .map((name) => ({ name, mtime: fs.statSync(path.join(distDir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0]?.name;
  if (!tgz) {
    console.error(`✗ dist/ 里没有生成的 tgz`);
    process.exit(1);
  }
  const tgzPath = path.join(distDir, tgz);
  console.log(`tarball      : ${tgzPath}`);

  const profileManifest = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  profileManifest.dependencies = profileManifest.dependencies || {};
  profileManifest.dependencies[PKG] = `file:${tgzPath}`;
  profileManifest.dsh = profileManifest.dsh || {};
  profileManifest.dsh.profile = profileManifest.dsh.profile || {};
  const bundles = profileManifest.dsh.profile.bundles || [];
  if (!bundles.includes(PKG)) bundles.push(PKG);
  profileManifest.dsh.profile.bundles = bundles;
  fs.writeFileSync(pkgPath, `${JSON.stringify(profileManifest, null, 2)}\n`, "utf8");
  console.log(`dependency   : ${PKG} = file:${tgzPath}`);
  console.log(`bundles      : 含 ${PKG}`);

  const install = runPnpm(["install"], { cwd: profileDir, stdio: "inherit" });
  if (install.status !== 0) {
    console.error("✗ pnpm install 失败，profile 的 package.json 已备份，可回滚");
    process.exit(1);
  }

  const verify = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "verify-import.mjs"), profileDir], {
    stdio: "inherit",
  });
  if (verify.status !== 0) console.error("✗ 静态体检未通过");
}

console.log("");
console.log("下一步：**重启 DSH 桌面端**。宿主按模块路径缓存已加载的插件，");
console.log("热重载只重组配置树，换不掉已经判 rejected 的那个插件行。重启后复查：");
console.log("  GET http://127.0.0.1:<web端口>/buddy-checkin/status  → 200 且有 status 字段");
