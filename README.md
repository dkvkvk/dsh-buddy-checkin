# dsh-buddy-checkin（自维护分支）

DSH 启动时自动为 **WorkBuddy 国内版**账号完成每日签到，领取每日积分；会话标题行显示签到状态点，点开可看每个账号的结果与余额。

本仓库是 [上游 `dsh-buddy-checkin@0.4.1`](https://www.npmjs.com/package/dsh-buddy-checkin)（作者 Corrine Hu，MIT **已声明停止维护**）的 **自维护构建**，用于跟踪 DSH 内核的预发布线。

- 当前版本：**`0.4.1-r1`**
- 适配目标：**DSH 内核 `0.2.1-rc.5`**（peer 范围放宽到整条 `0.2.x` 线）
- 上游源码：未公开（`corrinehu/dsh-buddy-checkin` 匿名 404，npm 包里只有构建产物 `lib/`，无 `src`、无 sourcemap）
- 上游文档：见 [`UPSTREAM-README.md`](./UPSTREAM-README.md)

## 与上游 0.4.1 的差异

| 改动 | 位置 | 原因 |
|---|---|---|
| `peerDependencies["@deepseek-ai/dsh-host-webserver"]` 尾部由 `… \|\| 0.2.1-rc.1 \|\| 0.2.1-rc.2` 改为 `… \|\| >=0.2.1-rc.1 <0.3.0-0` | `package.json` | 上游是**枚举式白名单**，讲到 `0.2.1-rc.2` 就停了；宿主升到 `0.2.1-rc.5` 后兼容闸门判定不满足，整行被标「异常」并在启动时跳过 |
| `version` → `0.4.1-r1`、`private: true` | `package.json` | 与上游版本区分；`private` 防止误发到 npm（这个名字属于上游） |
| `repository` / `homepage` / `bugs` → 本仓库 | `package.json` | 自维护 |
| 删掉上游的 `scripts`（`prepack` / `build: tsdown` / `test`）与 `devDependencies` 构建链，换成 `verify` / `install-profile` | `package.json` | 本仓库直接维护构建产物，没有 `src`；`prepack: npm run build` 会因缺 `tsdown` 让 `pnpm pack` 直接失败 |
| 新增自维护 README / CHANGELOG / `scripts/` | 仓库根 | 记录差异、静态体检、可重复安装 |

`lib/`、`assets/`、`cordis.patch.yml` **一行未改**，与 npm 上的 0.4.1 逐字节一致。

## 「与 DSH 版本不兼容」到底坏在哪

宿主的判定链在 `app.asar` 内 `@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility()`：

1. 清单声明了 `engines.dsh` → **只**看它，完全忽略 `peerDependencies`；
2. 否则逐个检查 `peerDependencies` 里的 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*`（`@deepseek-ai/cordis` 不检查）；
3. 比较方式是 `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`，**任一条不满足 → 该插件行判 rejected**，启动时跳过。

上游给的 `… || 0.2.1-rc.2` 是「枚举到 rc.2 为止」的写法，`0.2.1-rc.5` 比它新且没有任何一条分支覆盖它 → 判不兼容。而插件**真正用到的 API 在 rc.5 完全没变**：

- `webCtx.webServer.register({ kind: "exact", path, handler })`（`@deepseek-ai/dsh-host-webserver` 0.2.1-rc.5 的签名一致，服务名仍是 `webServer`）
- `ctx.clientModules`（`@deepseek-ai/dsh-client-modules` 仍在）
- `ctx.inject(["webServer"])` / `Ctx.effect`

换句话说：**坏的只是元数据，不是代码。**

改法有两条，本仓库做的是第一条，两条建议都做：

1. **放宽 peer 范围**（本仓库）：`>=0.2.1-rc.1 <0.3.0-0`。上界写 `<0.3.0-0` 而不是 `<0.3.0` —— 后者在 `includePrerelease` 下会把 `0.3.0-rc.1` 也放进来。
2. **profile 的精确版本豁免**：在 `~/.dsh/profiles/<profile>/compatibility.json` 里给 `"dsh-buddy-checkin@<version>": ["<内核版本>"]`。这是宿主官方机制，**pnpm 重装把 `package.json` 覆盖回原样时它仍然有效**，所以留作兜底。

## 安装到 desktop profile

`desktop` profile 由 DSH 桌面端独占，CLI 的 `dsh plugin --profile desktop add` 会被拒，所以走「打包 tarball → 用宿主自带 pnpm 装」：

```sh
node scripts/install-into-profile.mjs --dry-run   # 先看要改什么
node scripts/install-into-profile.mjs             # 打包 + 装进 desktop profile
```

也可以直接从 GitHub 装（不走 npm）：

```sh
dsh plugin --profile <非desktop的profile> add github:dkvkvk/dsh-buddy-checkin
```

装完/改完 `package.json` 后**必须重启 DSH**：宿主按模块路径缓存已加载的插件，热重载只会重组配置树，换不掉已判 rejected 的那一行。

## 静态体检

```sh
node scripts/verify-import.mjs                      # 默认 ~/.dsh/profiles/desktop
node scripts/verify-import.mjs <profileDir>
```

打印已安装版本、peer 范围、profile 里的豁免记录，并真正 `import` 一次 host 半边，确认 `apply` / `inject` / `name` 三个导出齐全。

## 功能与已知限制（沿用上游）

- 开箱即用：装好即生效，DSH 启动时自动签到；当天已签过的账号（含在 App 内手动签过的）自动跳过。
- 多账号自动发现：扫描本机 WorkBuddy 桌面 App 的共享登录目录，按账号去重、各取最新凭据；目录位置与 `dsh-workbuddy-connect` 保持同步。
- 兼容 WorkBuddy 5.6+ 的加密授权文件（借用本机 App 的 Electron 取解密密钥，密钥只在内存中使用、不落盘不外传）。
- 仅国内版；TUI 未适配（客户端界面是浏览器形态，只在 Web / Desktop 下提供）；不开 DSH 的日子不签到（上游不做 cron，只支持签当天）。
- 依赖 WorkBuddy 客户端接口（非官方开放 API），App 更新后可能需要跟着调整。

## 许可与归属

MIT。`lib/`、`assets/`、`cordis.patch.yml` 与文档版权归上游作者 Corrine Hu；本仓库只改元数据并新增维护性文档与脚本。与腾讯、WorkBuddy、DeepSeek 均无关联。
