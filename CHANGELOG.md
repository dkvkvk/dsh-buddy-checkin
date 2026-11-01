# Changelog

本仓库从上游 `dsh-buddy-checkin@0.4.1`（npm，2026-10-19 发布）分叉而来，版本号采用 `<上游版本>-r<修订>`。
上游已在 npm 上标注「因个人精力有限，本项目已停止维护」，仓库匿名 404，`npm view` 的 `latest` 就是 0.4.1 —— 没有「等上游更新一版来适配」这条路。

## 0.4.1-r1 — 2026-11-01

首个自维护版本，目标是让上游 0.4.1 在 **DSH `0.2.1-rc.5`** 上直接可用（不再依赖 profile 里的兼容豁免）。

**改动**

- `peerDependencies`：`@deepseek-ai/dsh-host-webserver` 由枚举式 `^0.1.5-rc.1 || ^0.1.7-rc.1 || 0.2.0-rc.1 || 0.2.0-rc.2 || 0.2.1-rc.1 || 0.2.1-rc.2` 放宽为 `^0.1.5-rc.1 || ^0.1.7-rc.1 || 0.2.0-rc.1 || 0.2.0-rc.2 || >=0.2.1-rc.1 <0.3.0-0`
  - 依据 1：宿主的判定是 `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`（见 `@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility`），带上界开区间后，`0.2.1-rc.3`~`rc.9`、`0.2.1`、乃至 `0.2.2-rc.1` 都放行；
  - 依据 2：上界必须是 `<0.3.0-0` 而不是 `<0.3.0` —— 开 `includePrerelease` 时 `0.3.0-rc.1 < 0.3.0`，写 `<0.3.0` 会把下一个大版本的预发布也放进来，等于放弃闸门；
  - `@deepseek-ai/cordis` 的 peer 保持 `^4.0.2` 不动（宿主是 `~4.0.5`，本来就能过；且判定只看 `@deepseek-ai/dsh*`）。
- `package.json`：`version` → `0.4.1-r1`，`private: true`（防止误发到 npm，名字属于上游），`repository` / `homepage` / `bugs` 指向本仓库（`bugs` 保留上游 issue 地址，因为上游已收录不到）。
- `package.json`：删掉上游 `scripts`（`prepack: npm run build`、`build: tsdown`、`test: vitest run`、`typecheck`）与 `devDependencies`（构建链 + 钉死 `0.2.1-rc.2` 的 dev peer），换成 `verify` / `install-profile`；否则 `pnpm pack` 会因缺 `tsdown` 直接失败。
- `package.json`：补 `files` 白名单（`lib`、`assets`、`cordis.patch.yml`、`LICENSE`、`README.md`、`CHANGELOG.md`、`THIRD_PARTY_NOTICES.txt`、`UPSTREAM-README.md`、`scripts`）。
- 新增：自维护 `README.md`、本 `CHANGELOG.md`、`scripts/verify-import.mjs`（静态体检）、`scripts/install-into-profile.mjs`（打包 tarball + 装机，可重复执行）。
- 上游文档保留为 `UPSTREAM-README.md`。

**未改动**

- `lib/index.mjs`、`lib/index.d.mts`、`lib/client.js`、`assets/1.png`、`cordis.patch.yml` 与 npm 上的 0.4.1 **逐字节一致**。

**诊断依据（本次事故）**

- 现象：插件面板显示「异常」，原因「`dsh-buddy-checkin@0.4.1` 与 DSH `0.2.1-rc.5` 不兼容（要求 `@deepseek-ai/dsh-host-webserver … 0.2.1-rc.2`）」，启动时该行被跳过，`/buddy-checkin/status` 返回 **404**。
- 判定源码：`app.asar` 内 `dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js` → `evaluatePluginCompatibility()`；有 `engines.dsh` 时只看它、忽略 peer；否则逐条比对 `@deepseek-ai/dsh*` peer，用 `includePrerelease` 的 semver。
- API 侧复核：`@deepseek-ai/dsh-host-webserver@0.2.1-rc.5` 的 `register(route: { kind, path, handler })` 与插件调用完全一致，服务名仍是 `webServer`；`ctx.clientModules` 对应的 `@deepseek-ai/dsh-client-modules` 仍在宿主内。**代码本身无需改动。**

**验证记录**

- 宿主判定函数复算（含 `includePrerelease` 与豁免表）：`unmet requirements = {}`，verdict `ACCEPTED`。
- 隔离实例（独立 `DSH_HOME` + `mklink /J` 链真实 `node_modules`，`compatibility.json` **故意留空 `{}`**，端口 59942，宿主 `0.2.1-rc.5`）：
  `GET /buddy-checkin/status` → **200**
  ```json
  {"day":"2026-11-01","checkedAt":"2026-11-01T07:27:07.078Z","results":[{"nickname":"Serendipity","state":"signed","credit":100,"balance":4567}],"status":"ok"}
  ```
  证明的是 **peer 修复本身生效**，不是靠豁免蒙过去的；同时确认宿主升级后该插件功能正常。
- 当前主实例在修复前启动，组合树里那一行已判 rejected；`/buddy-checkin/status` 仍 404，**重启 DSH 后生效**。

**遗留**

- 宿主升级到 `0.3.x` 时闸门会再拦一次（本仓库有意把上界钉在 `<0.3.0-0`）；届时按同法把上界顺延并重新验证即可。
- 上游源码不可得，本仓库不接功能改动；如有必要，只能从 `lib/` 产物反推重写。
