import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { homedir, release } from "node:os";
import { basename, dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { accessSync, constants, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { createDecipheriv, createHash } from "node:crypto";
//#region src/desktop-credential-protection.ts
/** Env variable pointing at the WorkBuddy Electron binary to spawn as key helper. */
const WORKBUDDY_ELECTRON_BIN_ENV = "WORKBUDDY_ELECTRON_BIN";
/** Platform-default Electron binary; confirmed only on macOS (WorkBuddy 5.6.2). */
const MACOS_ELECTRON_PATH = "/Applications/WorkBuddy.app/Contents/MacOS/Electron";
/** CN app's measured default Windows install location, under %LOCALAPPDATA%. */
const WINDOWS_ELECTRON_DEFAULT_SEGMENTS = [
	"Programs",
	"WorkBuddy",
	"WorkBuddy.exe"
];
const WINDOWS_REGISTRY_ROOTS = [
	"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
	"HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
	"HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall"
];
const WINDOWS_REGISTRY_OUTPUT_MAX_BYTES = 1048576;
/** Electron `version` file shape, e.g. `37.10.3-24`. */
const WINDOWS_ELECTRON_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
/** CN uninstall DisplayName: `WorkBuddy` or `WorkBuddy 5.6.2`; never `WorkBuddy AI …`. */
const WINDOWS_DISPLAY_NAME_PATTERN = /^WorkBuddy(?:\s+\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?)?$/u;
const WINDOWS_EXE_BASENAME = "workbuddy.exe";
const DISCOVERY_STEP_TIMEOUT_MS = 3e3;
const DISCOVERY_BUDGET_MS = 1e4;
/** Decode a base64 value and check its exact byte length when given. */
function parseBase64(value, length) {
	if (typeof value !== "string" || value === "") return void 0;
	let decoded;
	try {
		decoded = Buffer.from(value, "base64");
	} catch {
		return;
	}
	if (decoded.length === 0 || decoded.toString("base64").replace(/=+$/u, "") !== value.replace(/=+$/u, "")) return void 0;
	return length === void 0 || decoded.length === length ? decoded : void 0;
}
/**
* Whether a raw value is the 5.6 field wrapper with a decodable envelope:
* `{$wbEncrypted:1, envelope:<base64 of {suite,keyId,nonce,authTag,ciphertext}>}`.
* Suite must be 1 — the only scheme 5.6.x defines for credential fields; a
* future format returns undefined so the caller surfaces "unrecognized"
* instead of attempting a blind open.
*/
function parseEnvelope(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
	const wrapped = value;
	if (wrapped["$wbEncrypted"] !== 1 || typeof wrapped["envelope"] !== "string") return void 0;
	let inner;
	try {
		inner = JSON.parse(Buffer.from(wrapped["envelope"], "base64").toString("utf8"));
	} catch {
		return;
	}
	if (typeof inner !== "object" || inner === null || Array.isArray(inner)) return void 0;
	const parts = inner;
	const nonce = parseBase64(parts["nonce"], 12);
	const authTag = parseBase64(parts["authTag"], 16);
	const ciphertext = parseBase64(parts["ciphertext"]);
	if (nonce === void 0 || authTag === void 0 || ciphertext === void 0) return void 0;
	if (typeof parts["suite"] !== "number" || !Number.isInteger(parts["suite"]) || parts["suite"] !== 1) return void 0;
	if (typeof parts["keyId"] !== "string" || !/^[0-9a-f]{16}$/u.test(parts["keyId"])) return void 0;
	return {
		suite: parts["suite"],
		keyId: parts["keyId"],
		nonce,
		authTag,
		ciphertext
	};
}
/**
* The authenticated-context AAD for one field envelope, transcribed from the
* app bundle's `buildAuthenticatedContextAad` and verified live against 5.6.2.
* Credential fields are always suite 1 under the `field` framing (WBEV1); no
* sequence numbers, final byte 0 mirrors the reference's default context.
*/
function buildAuthenticatedContextAad(keyId, suite) {
	const lengthPrefixed = (value) => {
		const bytes = Buffer.from(value, "utf8");
		const header = Buffer.allocUnsafe(4);
		header.writeUInt32BE(bytes.length);
		return Buffer.concat([header, bytes]);
	};
	const suiteBytes = Buffer.allocUnsafe(4);
	suiteBytes.writeUInt32BE(suite);
	return Buffer.concat([
		Buffer.from("WB-AAD\0", "ascii"),
		Buffer.from([1]),
		lengthPrefixed("WBEV1"),
		lengthPrefixed("sym-v1"),
		suiteBytes,
		lengthPrefixed(keyId),
		Buffer.from([2]),
		Buffer.from([0]),
		Buffer.from([0])
	]);
}
/** Open one envelope with a protector key; undefined when it will not open. */
function openAuthField(key, envelope) {
	try {
		const decipher = createDecipheriv("aes-256-gcm", key, envelope.nonce, { authTagLength: 16 });
		decipher.setAAD(buildAuthenticatedContextAad(envelope.keyId, envelope.suite));
		decipher.setAuthTag(envelope.authTag);
		return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString("utf8");
	} catch {
		return;
	}
}
/** The validated `loggerGet()` payload: the sealed at-rest secret. */
function parseAtRestPayload(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	const payload = parsed;
	if (payload["version"] !== 1) return void 0;
	const secret = payload["atRestSecretKey"];
	if (typeof secret !== "string" || secret === "") return void 0;
	let decoded;
	try {
		decoded = Buffer.from(secret, "base64");
	} catch {
		return;
	}
	if (decoded.length !== 32 || decoded.toString("base64") !== secret || decoded.every((byte) => byte === 0)) return void 0;
	return { atRestSecretKey: secret };
}
/** Derive the protector key from the payload's secret (sha256 over its UTF-8 string). */
function deriveProtectorKey(secret) {
	return createHash("sha256").update(secret, "utf8").digest();
}
/** The id envelopes name for a key: sha256(key) hex, first 16 chars. */
function keyIdOf(key) {
	return createHash("sha256").update(key).digest("hex").slice(0, 16);
}
/** The key helper cannot be reached: no binary, spawn failure, or unusable payload. */
var KeyUnavailableError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "KeyUnavailableError";
	}
};
function isExecutable(path) {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
/** Whether a filesystem error reports an absent path (`existsSync` cannot tell absent from unreadable). */
function isENOENT(error) {
	return error?.code === "ENOENT";
}
/**
* The Electron binary to spawn, or a diagnosable KeyUnavailableError. Order is
* the contract: an explicit `WORKBUDDY_ELECTRON_BIN` is used as-is and never
* falls back; then the platform default (Windows: %LOCALAPPDATA% measured
* layout); Windows finally falls back to uninstall-registry discovery — the
* CN product only, and only after every candidate proves the Electron layout.
*/
async function resolveElectronPath(env = process.env, platform = process.platform, opts = {}) {
	const configured = env[WORKBUDDY_ELECTRON_BIN_ENV]?.trim();
	if (configured !== void 0 && configured !== "") {
		if (!isExecutable(configured)) throw new KeyUnavailableError(`WORKBUDDY_ELECTRON_BIN 指定的 Electron 不可执行：${configured}`);
		return configured;
	}
	if (platform === "darwin") {
		if (!isExecutable(MACOS_ELECTRON_PATH)) throw new KeyUnavailableError("未找到 WorkBuddy 的 Electron 二进制（默认路径不可用，可能 App 装在别处）；可用 WORKBUDDY_ELECTRON_BIN 指定");
		return MACOS_ELECTRON_PATH;
	}
	if (platform !== "win32") throw new KeyUnavailableError("此平台没有默认的 WorkBuddy Electron 路径；请用 WORKBUDDY_ELECTRON_BIN 指定其 Electron 二进制");
	const localAppData = env.LOCALAPPDATA?.trim();
	const platformDefault = localAppData === void 0 || localAppData === "" ? void 0 : join(localAppData, ...WINDOWS_ELECTRON_DEFAULT_SEGMENTS);
	if (platformDefault !== void 0 && isExecutable(platformDefault)) return platformDefault;
	return await discoverWindowsElectron(env, opts);
}
/**
* Resolve the CN app's Electron through Windows uninstall records. Registry
* entries are hints, not trust: every DisplayIcon candidate must still be the
* product's exe with the known Electron layout before it is executed. Ported
* from dsh-workbuddy-connect (its #59/#60, with the #66 asar-safe layout
* check), simplified to the single CN product this plugin scans.
*/
async function discoverWindowsElectron(env, opts) {
	const registry = opts.registry ?? defaultRegistryRootQuery(env);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), opts.discoveryBudgetMs ?? DISCOVERY_BUDGET_MS);
	try {
		const candidates = [];
		let unresolved = false;
		for (const root of WINDOWS_REGISTRY_ROOTS) {
			let output;
			try {
				output = await registry(root, controller.signal);
			} catch {
				unresolved = true;
				continue;
			}
			const parsed = parseWindowsRegistryOutput(output);
			candidates.push(...parsed.candidates);
			unresolved ||= parsed.incomplete;
		}
		const seen = /* @__PURE__ */ new Map();
		const rejected = /* @__PURE__ */ new Map();
		const uncheckable = /* @__PURE__ */ new Set();
		for (const candidate of new Set(candidates)) {
			const inspection = inspectWindowsElectronCandidate(candidate);
			if (inspection === void 0) continue;
			if ("rejection" in inspection) {
				rejected.set(inspection.rejection, (rejected.get(inspection.rejection) ?? 0) + 1);
				continue;
			}
			if ("uncheckable" in inspection) {
				uncheckable.add(inspection.uncheckable);
				continue;
			}
			seen.set(inspection.identity, inspection.electronPath);
		}
		if (unresolved || uncheckable.size > 0) {
			const steps = [...unresolved ? ["部分注册表项无法查询"] : [], ...uncheckable];
			const transient = uncheckable.size > 0 ? "；可能是文件暂时不可访问，例如 App 正在升级，可稍后重启 DSH 重试" : "";
			throw new KeyUnavailableError(`WorkBuddy 的自动定位未能完成（${steps.join("、")}${transient}）；可用 WORKBUDDY_ELECTRON_BIN 指定`);
		}
		if (seen.size > 1) {
			const listed = [...seen.values()].map((path) => `  - ${path}`).join("\n");
			throw new KeyUnavailableError(`找到 ${seen.size} 个 WorkBuddy 安装，无法自动选择：\n${listed}\n可用 WORKBUDDY_ELECTRON_BIN 指定其一`);
		}
		if (seen.size === 1) return [...seen.values()][0];
		throw new KeyUnavailableError(rejected.size === 0 ? "未找到 WorkBuddy 的 Electron 二进制（默认位置与 Windows 卸载记录均未命中）；可用 WORKBUDDY_ELECTRON_BIN 指定" : `Windows 卸载记录找到 ${[...rejected.values()].reduce((n, count) => n + count, 0)} 个 WorkBuddy 候选，但未通过布局校验：${[...rejected.keys()].join("、")}（预期 exe 旁有 version 文件与 resources\\app.asar）；可用 WORKBUDDY_ELECTRON_BIN 指定其可执行文件`);
	} finally {
		clearTimeout(timer);
		controller.abort();
	}
}
/**
* The PowerShell fallback's location under SystemRoot, resolved by absolute
* path like `reg.exe` — never through PATH, which a user can change (#4,
* ported from dsh-workbuddy-connect #88).
*/
const WINDOWS_REGISTRY_RELATIVE_POWERSHELL = "System32\\WindowsPowerShell\\v1.0\\powershell.exe";
/** Exit code meaning the root key does not exist (a normal, expected outcome). */
const WINDOWS_POWERSHELL_ROOT_ABSENT = 2;
/** Exit code meaning the root exists but a part of it could not be read. */
const WINDOWS_POWERSHELL_ROOT_UNREADABLE = 3;
/**
* The `-Command` value actually handed to `powershell.exe`: the query script
* wrapped in a call-operator script block (connect #105/#106/#107).
*
* Windows PowerShell 5.1 joins every argument that follows `-Command` into
* one command string and runs that string as code. A bare `param(...)` script
* therefore never binds the trailing `-Root <path>` tokens — they end up
* inside the script text, `$Root` stays empty, and the query ends as exit
* 2/3: discovery incomplete, the app binary is never located. The call
* operator makes the binding explicit: the joined command becomes
* `& { …script… } -Root <path>`.
*/
const WINDOWS_POWERSHELL_QUERY_COMMAND = `& { ${[
	"param([string]$Root)",
	"[Console]::OutputEncoding=[Text.Encoding]::UTF8;",
	"$ErrorActionPreference=\"Stop\";",
	"$path=\"Registry::\"+$Root;",
	"if (-not (Test-Path -LiteralPath $path)) { [Console]::Error.Write(\"root absent\"); exit 2 };",
	"try { $k=Get-Item -LiteralPath $path -ErrorAction Stop } catch { [Console]::Error.Write(\"root unreadable\"); exit 3 };",
	"$out=@();",
	"foreach ($n in $k.GetSubKeyNames()) {",
	"  try { $p=$k.OpenSubKey($n); if ($null -eq $p) { throw \"null\" } } catch { [Console]::Error.Write(\"subkey unreadable\"); exit 3 };",
	"  $d=$p.GetValue(\"DisplayName\");$i=$p.GetValue(\"DisplayIcon\");",
	"  if ($null -ne $d -or $null -ne $i) { $out += [pscustomobject]@{ displayName=[string]$d; displayIcon=[string]$i } }",
	"};",
	"ConvertTo-Json -InputObject @($out) -Compress -Depth 3"
].join(" ")} }`;
/**
* The only roots this tool will name on a `-Command` command line: `powershell.exe`
* re-parses everything after `-Command` as code, so a root rides along only when it
* is provably inert — a real hive, then subkey components of plain path characters.
*/
const WINDOWS_REGISTRY_ROOT_PATTERN = /^HK(?:LM|CU)(?:\\[A-Za-z0-9._-]+)+$/u;
/** Only known missing-key diagnostics can safely make a failed query read as empty. */
function windowsRegistryKeyMissing(stderr) {
	const detail = stderr.trim();
	return /^ERROR:\s*The system was unable to find the specified registry key or value\.?$/iu.test(detail) || /^错误[:：]\s*系统找不到指定的注册表项或值[。.]?$/u.test(detail);
}
/**
* Whether every byte is ASCII, the one case where a decode cannot be wrong
* (#4 / connect #88). The trigger is a property of the *bytes*, never of a
* decoding: checking for U+FFFD instead would miss the 1920 distinct GBK byte
* pairs that decode as valid UTF-8 with no replacement character.
*/
function isAsciiOnly(bytes) {
	for (const byte of bytes) if (byte >= 128) return false;
	return true;
}
/**
* Turn the fallback's JSON into the same column-shaped document
* {@link parseWindowsRegistryOutput} already consumes, so the parser and the
* candidate-quoting rules apply unchanged. `ConvertTo-Json` collapses a
* one-element array into a bare object; records carrying neither value are
* skipped.
*/
function parseWindowsUninstallJson(output) {
	let document;
	try {
		document = JSON.parse(output);
	} catch {
		return;
	}
	const rows = Array.isArray(document) ? document : [document];
	const lines = [];
	for (const [index, row] of rows.entries()) {
		if (typeof row !== "object" || row === null) continue;
		const record = row;
		const displayName = record["displayName"];
		const displayIcon = record["displayIcon"];
		if (typeof displayName !== "string" && typeof displayIcon !== "string") continue;
		lines.push(`HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{PS-${String(index)}}`);
		if (typeof displayName === "string") lines.push(`    DisplayName    REG_SZ    ${displayName}`);
		if (typeof displayIcon === "string") lines.push(`    DisplayIcon    REG_SZ    ${displayIcon}`);
	}
	return lines.join("\r\n");
}
/**
* The real registry source: `reg.exe query <root> /s` under a per-step
* timeout, abandoned when the shared budget runs out. Output is captured as
* raw bytes: ASCII-only output is returned as-is (every code page agrees),
* while any byte at or above 0x80 means the code page is unknowable from the
* bytes and the same root is re-read through PowerShell's Unicode registry
* API instead (#4, ported from dsh-workbuddy-connect #88).
*/
function defaultRegistryRootQuery(env = process.env) {
	const systemRoot = env.SystemRoot?.trim();
	const regPath = systemRoot === void 0 || systemRoot === "" ? void 0 : join(systemRoot, "System32", "reg.exe");
	const powershellPath = systemRoot === void 0 || systemRoot === "" ? void 0 : join(systemRoot, WINDOWS_REGISTRY_RELATIVE_POWERSHELL);
	const runReg = (root, signal) => new Promise((resolve, reject) => {
		if (regPath === void 0) {
			reject(/* @__PURE__ */ new Error("SystemRoot 未配置，无法定位 reg.exe"));
			return;
		}
		if (signal.aborted) {
			reject(/* @__PURE__ */ new Error("发现预算已耗尽，reg.exe 未启动"));
			return;
		}
		let settled = false;
		const child = execFile(regPath, [
			"query",
			root,
			"/s"
		], {
			maxBuffer: WINDOWS_REGISTRY_OUTPUT_MAX_BYTES,
			timeout: DISCOVERY_STEP_TIMEOUT_MS,
			windowsHide: true,
			encoding: "buffer"
		}, (error, stdout, stderr) => {
			if (settled) return;
			settled = true;
			if (error !== null && error !== void 0) {
				if (error.killed !== true && (error.code === 1 || error.code === "1") && windowsRegistryKeyMissing(stderr.toString("utf8"))) {
					resolve(Buffer.alloc(0));
					return;
				}
				reject(/* @__PURE__ */ new Error(`reg.exe 未能完成（${error.killed === true ? "超时" : String(error.code ?? "不可用")}）`));
				return;
			}
			resolve(stdout);
		});
		const abort = () => {
			if (settled) return;
			settled = true;
			child.kill();
			reject(/* @__PURE__ */ new Error("发现预算已耗尽，reg.exe 被放弃"));
		};
		signal.addEventListener("abort", abort, { once: true });
		child.on("close", () => {
			signal.removeEventListener("abort", abort);
		});
	});
	const runFallback = (root, signal) => new Promise((resolve, reject) => {
		if (powershellPath === void 0) {
			reject(/* @__PURE__ */ new Error("SystemRoot 未配置，无法定位 powershell.exe"));
			return;
		}
		if (!WINDOWS_REGISTRY_ROOT_PATTERN.test(root)) {
			reject(/* @__PURE__ */ new Error("注册表根不是本工具可查询的 HKLM/HKCU 纯路径"));
			return;
		}
		if (signal.aborted) {
			reject(/* @__PURE__ */ new Error("发现预算已耗尽，powershell.exe 未启动"));
			return;
		}
		let settled = false;
		const child = execFile(powershellPath, [
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			WINDOWS_POWERSHELL_QUERY_COMMAND,
			"-Root",
			root
		], {
			maxBuffer: WINDOWS_REGISTRY_OUTPUT_MAX_BYTES,
			timeout: DISCOVERY_STEP_TIMEOUT_MS,
			windowsHide: true,
			encoding: "utf8"
		}, (error, stdout) => {
			if (settled) return;
			settled = true;
			if (error !== null && error !== void 0) {
				const code = error.killed === true ? void 0 : Number(error.code);
				if (code === WINDOWS_POWERSHELL_ROOT_ABSENT) {
					resolve("");
					return;
				}
				if (code === WINDOWS_POWERSHELL_ROOT_UNREADABLE) {
					reject(/* @__PURE__ */ new Error(`powershell.exe 无法读取注册表根 ${root}`));
					return;
				}
				reject(/* @__PURE__ */ new Error(`powershell.exe 未能完成（${error.killed === true ? "超时" : String(error.code ?? "不可用")}）`));
				return;
			}
			const records = parseWindowsUninstallJson(stdout);
			if (records === void 0) {
				reject(/* @__PURE__ */ new Error("powershell.exe 输出不是预期的注册表文档"));
				return;
			}
			resolve(records);
		});
		const abort = () => {
			if (settled) return;
			settled = true;
			child.kill();
			reject(/* @__PURE__ */ new Error("发现预算已耗尽，powershell.exe 被放弃"));
		};
		signal.addEventListener("abort", abort, { once: true });
		child.on("close", () => {
			signal.removeEventListener("abort", abort);
		});
	});
	return async (root, signal) => {
		const raw = await runReg(root, signal);
		if (isAsciiOnly(raw)) return raw.toString("utf8");
		return await runFallback(root, signal);
	};
}
/**
* Parse `reg query ... /s` value columns into DisplayIcon candidates. Entries
* are filtered by the CN DisplayName before the icon is judged, so another
* product's records — however broken — are excluded as decisively not ours
* and can never mark this product's search incomplete.
*/
function parseWindowsRegistryOutput(output) {
	const entries = /* @__PURE__ */ new Map();
	let currentKey;
	for (const line of output.split(/\r?\n/u)) {
		const keyMatch = /^\s*(HKEY_[^\r\n]+?)\s*$/iu.exec(line);
		if (keyMatch !== null) {
			currentKey = keyMatch[1];
			entries.set(currentKey, {});
			continue;
		}
		if (currentKey === void 0) continue;
		const valueMatch = /^\s+(DisplayName|DisplayIcon)\s+REG_[A-Z0-9_]+\s*(.*?)\s*$/iu.exec(line);
		if (valueMatch === null) continue;
		const entry = entries.get(currentKey);
		if (entry === void 0) continue;
		if (valueMatch[1].toLowerCase() === "displayname") entry.displayName = valueMatch[2] ?? "";
		else entry.displayIcon = valueMatch[2] ?? "";
	}
	const candidates = [];
	let incomplete = false;
	for (const entry of entries.values()) {
		if (entry.displayName === void 0) continue;
		if (!WINDOWS_DISPLAY_NAME_PATTERN.test(entry.displayName.trim())) continue;
		const displayIcon = entry.displayIcon === void 0 ? void 0 : parseWindowsDisplayIcon(entry.displayIcon);
		if (displayIcon === void 0) incomplete = true;
		else candidates.push(displayIcon);
	}
	return {
		candidates,
		incomplete
	};
}
/** Read a quoted DisplayIcon path and drop the Windows icon-index suffix. */
function parseWindowsDisplayIcon(value) {
	const raw = value.trim();
	let path;
	if (raw.startsWith("\"")) {
		const closingQuote = raw.indexOf("\"", 1);
		if (closingQuote < 0) return void 0;
		const suffix = raw.slice(closingQuote + 1).trim();
		if (suffix !== "" && !/^,\d+$/u.test(suffix)) return void 0;
		path = raw.slice(1, closingQuote).replace(/,\d+$/u, "");
	} else {
		const match = /^(.+?\.exe)(?:,\d+)?$/iu.exec(raw);
		if (match === null) return void 0;
		path = match[1];
	}
	path = path.trim();
	return /\.exe$/iu.test(path) ? path : void 0;
}
function inspectWindowsElectronCandidate(electronPath) {
	if (basename(electronPath).toLowerCase() !== WINDOWS_EXE_BASENAME) return { rejection: "exe 不是 WorkBuddy.exe" };
	let binaryStat;
	try {
		binaryStat = statSync(electronPath);
	} catch (error) {
		return isENOENT(error) ? void 0 : { uncheckable: "无法读取候选 exe 的文件状态" };
	}
	if (!binaryStat.isFile()) return { rejection: "exe 不是普通文件" };
	try {
		accessSync(electronPath, constants.X_OK);
	} catch {
		return { uncheckable: "候选 exe 不可执行" };
	}
	const installRoot = dirname(electronPath);
	let version;
	try {
		version = readFileSync(join(installRoot, "version"), "utf8").trim();
	} catch (error) {
		return isENOENT(error) ? { rejection: "缺少 version 文件" } : { uncheckable: "无法读取 version 文件" };
	}
	if (!WINDOWS_ELECTRON_VERSION_PATTERN.test(version)) return { rejection: "version 文件不是预期的 Electron 版本号" };
	try {
		if (!readdirSync(join(installRoot, "resources")).includes("app.asar")) return { rejection: "缺少 resources\\app.asar" };
	} catch (error) {
		return isENOENT(error) ? { rejection: "缺少 resources\\app.asar" } : { uncheckable: "无法读取 resources 目录" };
	}
	let identity;
	try {
		identity = realpathSync(electronPath);
	} catch (error) {
		return { uncheckable: "无法解析候选 exe 的真实路径" };
	}
	return {
		electronPath,
		identity: identity.toLowerCase()
	};
}
const HELPER_SCRIPT = "process.stdout.write(String(process._linkedBinding(\"electron_browser_workbuddy_storage\").loggerGet()))";
function spawnPayload(electronPath, timeoutMs = 1e4) {
	return new Promise((resolve, reject) => {
		execFile(electronPath, ["-e", HELPER_SCRIPT], {
			timeout: timeoutMs,
			maxBuffer: 1048576,
			windowsHide: true,
			env: {
				...process.env,
				ELECTRON_RUN_AS_NODE: "1"
			}
		}, (error, stdout) => {
			if (error !== null && error !== void 0) {
				reject(new KeyUnavailableError(`获取解密密钥失败（${electronPath} ${error.killed === true ? `超时 ${timeoutMs}ms` : error.code !== void 0 ? `退出码 ${error.code}` : "无法启动"}）`));
				return;
			}
			const output = stdout.trim();
			if (output === "") {
				reject(new KeyUnavailableError(`获取解密密钥失败（${electronPath} 无输出）`));
				return;
			}
			resolve(output);
		});
	});
}
/** The real source: resolve the binary on this machine (explicit env → platform default → Windows registry discovery), spawn it once, take its payload. */
async function defaultKeySource() {
	return await spawnPayload(await resolveElectronPath());
}
let cachedDefault;
let inflightDefault;
/**
* The machine's current protector key. Deliberately does NOT enforce that
* envelope key ids match — matching each envelope is the caller's job, so a
* backup sealed by a previous install can be skipped without failing here.
*/
async function protectorKey(source) {
	if (source === void 0) {
		if (cachedDefault !== void 0) return cachedDefault;
		inflightDefault ??= (async () => {
			const payload = parseAtRestPayload(await defaultKeySource());
			if (payload === void 0) throw new KeyUnavailableError("获取解密密钥失败：payload 不合法（应为 {version:1, atRestSecretKey}）");
			const key = deriveProtectorKey(payload.atRestSecretKey);
			return {
				key,
				keyId: keyIdOf(key)
			};
		})().finally(() => {
			inflightDefault = void 0;
		}).then((resolved) => {
			cachedDefault = resolved;
			return resolved;
		});
		return inflightDefault;
	}
	const payload = parseAtRestPayload(await source());
	if (payload === void 0) throw new KeyUnavailableError("获取解密密钥失败：payload 不合法（应为 {version:1, atRestSecretKey}）");
	const key = deriveProtectorKey(payload.atRestSecretKey);
	return {
		key,
		keyId: keyIdOf(key)
	};
}
//#endregion
//#region src/checkin.ts
/** Whether this Linux process is running inside Windows Subsystem for Linux. */
function isWsl(platform, env) {
	if (platform !== "linux") return false;
	if (env.WSL_DISTRO_NAME !== void 0 || env.WSL_INTEROP !== void 0) return true;
	return release().toLowerCase().includes("microsoft");
}
/** Convert a Windows drive path to WSL's conventional /mnt/<drive> form; already-native paths pass through. */
function windowsPathForWsl(value) {
	const path = value?.trim();
	if (path === void 0 || path === "") return void 0;
	if (path.startsWith("/")) return path;
	const drive = /^([a-z]):[\\/](.*)$/iu.exec(path);
	return drive === null ? void 0 : join("/mnt", drive[1].toLowerCase(), ...drive[2].split(/[\\/]+/u));
}
/** Windows auth dirs seen from a WSL process, through its mounted Windows profile. */
function wslWindowsBases(env, home) {
	const profile = windowsPathForWsl(env.USERPROFILE) ?? join("/mnt/c/Users", basename(home));
	return [windowsPathForWsl(env.LOCALAPPDATA) ?? join(profile, "AppData", "Local"), windowsPathForWsl(env.APPDATA) ?? join(profile, "AppData", "Roaming")];
}
/** The XDG base for one env variable, or its platform default; an override is adopted only as a non-empty absolute path. */
function xdgBase(env, name, fallback) {
	const value = env[name]?.trim();
	return value !== void 0 && value !== "" && value.startsWith("/") ? value : fallback;
}
/**
* Windows prefers Local, with Roaming for older desktop versions. Linux probes
* both XDG bases — most distributions write under the config home, but
* UOS/deepin builds under the data home (workbuddy-connect #43). Under WSL
* the Windows-side auth dirs are probed first through the mounted profile
* (workbuddy-connect #4): the desktop app there is the Windows one, whose
* credentials live on the Windows disk.
*/
function authDirsFor(platform = process.platform, env = process.env, home = homedir()) {
	const bases = platform === "win32" ? [env.LOCALAPPDATA || join(home, "AppData", "Local"), env.APPDATA || join(home, "AppData", "Roaming")] : platform === "darwin" ? [join(home, "Library", "Application Support")] : isWsl(platform, env) ? [
		...wslWindowsBases(env, home),
		xdgBase(env, "XDG_CONFIG_HOME", join(home, ".config")),
		xdgBase(env, "XDG_DATA_HOME", join(home, ".local", "share"))
	] : [xdgBase(env, "XDG_CONFIG_HOME", join(home, ".config")), xdgBase(env, "XDG_DATA_HOME", join(home, ".local", "share"))];
	return [...new Set(bases.map((base) => join(base, "CodeBuddyExtension", "Data", "Public", "auth")))];
}
const statePath = () => join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), ".buddy-checkin.json");
/** Pre-rename state file, read as a fallback so upgrading keeps today's results (next save writes the new path). */
const legacyStatePath = (path) => path.endsWith(".buddy-checkin.json") ? path.replace(/\.buddy-checkin\.json$/u, ".workbuddy-checkin.json") : void 0;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(/* @__PURE__ */ new Date());
function string(v) {
	return typeof v === "string" && v !== "" ? v : void 0;
}
function candidate(name, raw) {
	if (!raw || typeof raw !== "object") return void 0;
	const d = raw;
	const a = d.account;
	const auth = d.auth;
	const uid = string(a?.uid);
	const domain = string(auth?.domain) ?? string((a?.domain)?.domain);
	if (!uid || !domain) return void 0;
	const token = string(auth?.accessToken);
	const tokenEnvelope = token === void 0 ? parseEnvelope(auth?.accessToken) : void 0;
	const nickname = string(a?.nickname);
	const nicknameEnvelope = nickname === void 0 ? parseEnvelope(a?.nickname) : void 0;
	return {
		name,
		uid,
		domain,
		...token === void 0 ? {} : { token },
		...tokenEnvelope === void 0 ? {} : { tokenEnvelope },
		...nickname === void 0 ? {} : { nickname },
		...nicknameEnvelope === void 0 ? {} : { nicknameEnvelope }
	};
}
/** Best credential for one uid: newest file first, skipping encrypted backups this machine's key cannot open. */
function resolveUid(files, key, keyError) {
	for (const f of files) {
		if (f.token !== void 0) return { credential: {
			uid: f.uid,
			domain: f.domain,
			accessToken: f.token,
			...f.nickname === void 0 ? {} : { nickname: f.nickname }
		} };
		if (f.tokenEnvelope !== void 0 && key !== void 0 && key.keyId === f.tokenEnvelope.keyId) {
			const token = openAuthField(key.key, f.tokenEnvelope);
			if (token === void 0) continue;
			const nickname = f.nicknameEnvelope === void 0 ? void 0 : openAuthField(key.key, f.nicknameEnvelope);
			return { credential: {
				uid: f.uid,
				domain: f.domain,
				accessToken: token,
				...nickname === void 0 || nickname === "" ? {} : { nickname }
			} };
		}
	}
	const encrypted = files.some((f) => f.tokenEnvelope !== void 0);
	return { reason: encrypted && keyError !== void 0 ? `凭据已加密，${keyError}` : encrypted ? "凭据由旧密钥加密，当前 WorkBuddy 无法解开（可能为重装 App 前的备份）；在 WorkBuddy App 重新登录该账号可恢复" : "凭据文件格式无法识别；在 WorkBuddy App 重新登录该账号可恢复" };
}
/**
* Discover every account that ever signed in on this machine, each uid with
* its newest *usable* credential. Since WorkBuddy 5.6 the desktop app seals
* `accessToken` (and `nickname`) into `$wbEncrypted` envelopes; those are
* opened with the machine's current key, obtained by spawning the app's own
* Electron once (see desktop-credential-protection.ts). An encrypted backup
* the key cannot open falls back to that uid's older plaintext files; a uid
* with no usable file at all is reported in `unreadable` instead of silently
* disappearing.
*/
async function discover(dirs = authDirsFor(), opts = {}) {
	let accumulated = [];
	for (const dir of typeof dirs === "string" ? [dirs] : dirs) {
		const files = await readdir(dir).catch(() => []);
		const groups = /* @__PURE__ */ new Map();
		for (const name of files) {
			if (!(name === "workbuddy-desktop.info" || /^workbuddy-desktop\.\d{4}-/u.test(name))) continue;
			let raw = null;
			try {
				raw = JSON.parse(await readFile(join(dir, name), "utf8"));
			} catch {}
			const c = candidate(name, raw);
			if (c === void 0) continue;
			const list = groups.get(c.uid) ?? [];
			list.push(c);
			groups.set(c.uid, list);
		}
		if (groups.size === 0) continue;
		for (const list of groups.values()) list.sort((x, y) => y.name < x.name ? -1 : y.name > x.name ? 1 : 0);
		let key;
		let keyError;
		if ([...groups.values()].some((list) => list.some((c) => c.tokenEnvelope !== void 0))) try {
			key = await protectorKey(opts.keySource);
		} catch (e) {
			keyError = e instanceof Error ? e.message : String(e);
		}
		const credentials = [];
		const unreadable = [];
		for (const [uid, list] of groups) {
			const resolved = resolveUid(list, key, keyError);
			if (resolved.credential !== void 0) credentials.push(resolved.credential);
			else unreadable.push({
				uid,
				reason: resolved.reason ?? "凭据无法读取"
			});
		}
		if (credentials.length > 0) {
			const rescued = new Set(credentials.map((c) => c.uid));
			return {
				credentials,
				unreadable: [...accumulated, ...unreadable].filter((u) => !rescued.has(u.uid))
			};
		}
		accumulated = [...accumulated, ...unreadable];
	}
	return {
		credentials: [],
		unreadable: accumulated
	};
}
function headers(c) {
	return {
		"content-type": "application/json",
		"authorization": `Bearer ${c.accessToken}`,
		"x-user-id": c.uid,
		"x-domain": c.domain,
		...c.enterpriseId ? {
			"x-enterprise-id": c.enterpriseId,
			"x-tenant-id": c.enterpriseId
		} : {}
	};
}
async function balance(c) {
	const r = await fetch(`https://${c.domain}/v2/billing/meter/get-user-resource`, {
		method: "POST",
		headers: headers(c),
		signal: AbortSignal.timeout(15e3),
		body: JSON.stringify({
			PageNumber: 1,
			PageSize: 100,
			ProductCode: "p_tcaca",
			Status: [0, 3]
		})
	});
	const b = await r.json();
	const a = b?.data?.Response?.Data?.Accounts;
	return r.ok && (b?.code === void 0 || b.code === 0) && Array.isArray(a) ? a.reduce((n, x) => n + (typeof x?.CycleCapacityRemain === "number" ? x.CycleCapacityRemain : 0), 0) : void 0;
}
async function check(c, now = /* @__PURE__ */ new Date()) {
	const at = now.toISOString();
	try {
		const r = await fetch(`https://${c.domain}/v2/billing/meter/daily-checkin`, {
			method: "POST",
			headers: headers(c),
			body: "{}"
		});
		const b = await r.json();
		const already = string(b?.msg)?.includes("已签到") === true;
		if (!r.ok && !already) throw new Error(String(b?.msg ?? `HTTP ${r.status}`));
		const total = await balance(c).catch(() => void 0);
		return {
			uid: c.uid,
			...c.nickname ? { nickname: c.nickname } : {},
			state: already ? "already" : "signed",
			at,
			...!already && typeof b?.data?.credit === "number" ? { credit: b.data.credit } : {},
			...total === void 0 ? {} : { balance: total }
		};
	} catch (e) {
		return {
			uid: c.uid,
			...c.nickname ? { nickname: c.nickname } : {},
			state: "failed",
			at,
			error: e instanceof Error ? e.message : String(e)
		};
	}
}
function savedDocument(parsed) {
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return void 0;
	const d = parsed;
	if (typeof d.day !== "string" || typeof d.checkedAt !== "string" || !Array.isArray(d.results)) return void 0;
	return d;
}
async function load(path = statePath()) {
	try {
		return savedDocument(JSON.parse(await readFile(path, "utf8")));
	} catch {}
	const legacy = legacyStatePath(path);
	if (legacy === void 0) return void 0;
	try {
		return savedDocument(JSON.parse(await readFile(legacy, "utf8")));
	} catch {
		return;
	}
}
async function save(saved, path = statePath()) {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.tmp`;
	await writeFile(temporary, JSON.stringify(saved), { mode: 384 });
	await rename(temporary, path);
	return saved;
}
/** Refresh balances without repeating the daily check-in. */
async function refreshBalances(path = statePath(), accounts, opts = {}) {
	const previous = await load(path);
	if (!previous) return void 0;
	let discovered;
	let unreadableByUid = /* @__PURE__ */ new Map();
	if (accounts === void 0) {
		const d = await discover(authDirsFor(), opts);
		discovered = d.credentials;
		unreadableByUid = new Map(d.unreadable.map((u) => [u.uid, u.reason]));
	} else discovered = accounts;
	const accountByUid = new Map(discovered.map((account) => [account.uid, account]));
	const results = await Promise.all(previous.results.map(async (result) => {
		const account = accountByUid.get(result.uid);
		if (account === void 0) return {
			...result,
			balanceError: unreadableByUid.get(result.uid) ?? "未找到登录凭据，显示上次记录"
		};
		const total = await balance(account).catch(() => void 0);
		return total === void 0 ? {
			...result,
			balanceError: "余额查询失败，显示上次记录"
		} : {
			...result,
			balance: total,
			balanceCheckedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
	}));
	const latest = await load(path);
	if (!latest || latest.day !== previous.day) return latest;
	const observations = new Map(results.map((result) => [result.uid, result]));
	return {
		...latest,
		results: latest.results.map((result) => {
			const observed = observations.get(result.uid);
			if (!observed) return result;
			return {
				...result,
				...observed.balance === void 0 ? {} : { balance: observed.balance },
				...observed.balanceCheckedAt ? { balanceCheckedAt: observed.balanceCheckedAt } : {},
				...observed.balanceError ? { balanceError: observed.balanceError } : {}
			};
		})
	};
}
/**
* The state for a status response, handing a persisted notice to its first
* reader only: that read also strips the notice from the state file, so a
* remount or a second window no longer re-toasts it (issue #2). Only the
* notice is removed — re-reading before the write keeps any concurrent
* check-in/retry results, and a day change abandons the stale claim.
*/
async function claimNotice(path = statePath()) {
	const saved = await load(path);
	if (saved === void 0 || saved.notice === void 0) return saved;
	const latest = await load(path);
	if (latest === void 0) return saved;
	if (latest.day !== saved.day) return latest;
	if (latest.notice === void 0) return latest;
	const { notice: _claimed, ...withoutNotice } = latest;
	try {
		await save(withoutNotice, path);
	} catch {}
	return latest;
}
async function run(path = statePath(), opts = {}) {
	const previous = await load(path);
	const day = today();
	const sameDay = previous?.day === day;
	const prior = sameDay ? previous.results : [];
	const completed = new Map(prior.filter((x) => x.state !== "failed").map((x) => [x.uid, x]));
	const { credentials, unreadable } = await discover(authDirsFor(), opts);
	const attempted = await Promise.all(credentials.filter((c) => !completed.has(c.uid)).map((c) => check(c)));
	const blocked = unreadable.filter((u) => !completed.has(u.uid)).map((u) => ({
		uid: u.uid,
		state: "failed",
		at: (/* @__PURE__ */ new Date()).toISOString(),
		error: u.reason
	}));
	const tried = [...attempted, ...blocked];
	const results = credentials.map((c) => completed.get(c.uid)).filter((x) => x !== void 0).concat(tried);
	const ok = tried.filter((x) => x.state !== "failed").length;
	const notice = opts.notice === false || tried.length === 0 ? void 0 : tried.some((x) => x.state === "failed") ? `WorkBuddy 签到 ${ok}/${tried.length} 成功，失败账号可在面板中重试` : `WorkBuddy 已完成今日签到：${ok} 个账号`;
	return save({
		day,
		checkedAt: (/* @__PURE__ */ new Date()).toISOString(),
		results,
		...sameDay && previous?.balanceCheckedAt ? { balanceCheckedAt: previous.balanceCheckedAt } : {},
		...notice === void 0 ? {} : { notice }
	}, path);
}
/**
* Interactive day-rollover guard for a long-lived DSH process: state stored for
* an earlier day triggers a fresh full attempt. run() never re-requests rows
* already signed or already credited today, so this is safe on every open.
*/
async function ensureToday(path = statePath(), opts = {}) {
	const saved = await load(path);
	return saved?.day === today() ? saved : run(path, opts);
}
/** The panel only retries accounts that failed in today's startup attempt. */
async function retryFailed(path = statePath(), opts = {}) {
	const previous = await load(path);
	if (!previous || previous.day !== today()) return run(path, opts);
	const { credentials, unreadable } = await discover(authDirsFor(), opts);
	const accountByUid = new Map(credentials.map((account) => [account.uid, account]));
	const retried = await Promise.all(previous.results.filter((result) => result.state === "failed").flatMap((result) => {
		const account = accountByUid.get(result.uid);
		return account === void 0 ? [] : [check(account)];
	}));
	const replacements = new Map(retried.map((result) => [result.uid, result]));
	const unreadableByUid = new Map(unreadable.map((u) => [u.uid, u.reason]));
	const priorByUid = new Map(previous.results.map((result) => [result.uid, result]));
	const results = [.../* @__PURE__ */ new Set([...accountByUid.keys(), ...priorByUid.keys()])].map((uid) => {
		const prior = priorByUid.get(uid);
		if (prior !== void 0 && prior.state !== "failed") return prior;
		const replacement = replacements.get(uid);
		if (replacement !== void 0) return replacement;
		if (accountByUid.has(uid)) return prior;
		const reason = unreadableByUid.get(uid);
		return reason === void 0 ? prior : {
			uid,
			state: "failed",
			at: (/* @__PURE__ */ new Date()).toISOString(),
			error: reason
		};
	}).filter((x) => x !== void 0);
	return save({
		day: previous.day,
		checkedAt: (/* @__PURE__ */ new Date()).toISOString(),
		results,
		...previous.balanceCheckedAt ? { balanceCheckedAt: previous.balanceCheckedAt } : {}
	}, path);
}
const status = (s) => s.results.length === 0 ? "none" : s.results.every((x) => x.state !== "failed") ? "ok" : s.results.some((x) => x.state !== "failed") ? "warn" : "error";
//#endregion
//#region src/index.ts
const name = "dsh-buddy-checkin";
const inject = ["webServer", "clientModules"];
const local = (value) => value === "localhost" || value?.startsWith("localhost:") === true || value === "127.0.0.1" || value?.startsWith("127.0.0.1:") === true || value === "[::1]" || value?.startsWith("[::1]:") === true;
function trusted(req) {
	if (!local(req.headers.host)) return false;
	const origin = req.headers.origin;
	if (origin === void 0) return true;
	try {
		return local(new URL(origin).host);
	} catch {
		return false;
	}
}
function respond(res, saved) {
	res.writeHead(200, { "content-type": "application/json" });
	res.end(JSON.stringify(saved ? {
		...saved,
		status: status(saved)
	} : {
		status: "none",
		results: []
	}));
}
function apply(ctx) {
	const modules = ctx.clientModules;
	ctx.logger.info(`client graph includes check-in: ${modules.graph().entries.some((entry) => entry.id === "dsh-buddy-checkin")}`);
	const startup = run().catch((error) => {
		ctx.logger.warn(error);
	});
	ctx.inject(["webServer"], (webCtx) => webCtx.effect(() => {
		const disposeStatus = webCtx.webServer.register({
			kind: "exact",
			path: "/buddy-checkin/status",
			handler: async (req, res) => {
				if (!trusted(req)) {
					res.writeHead(403);
					res.end();
					return;
				}
				if (req.method === "GET") {
					await startup;
					respond(res, await claimNotice());
					return;
				}
				if (req.method === "POST") {
					await startup;
					respond(res, await retryFailed());
					return;
				}
				res.writeHead(405, { allow: "GET, POST" });
				res.end();
			}
		});
		const disposeBalance = webCtx.webServer.register({
			kind: "exact",
			path: "/buddy-checkin/refresh-balance",
			handler: async (req, res) => {
				if (!trusted(req)) {
					res.writeHead(403);
					res.end();
					return;
				}
				if (req.method === "POST") {
					await startup;
					await ensureToday(void 0, { notice: false });
					respond(res, await refreshBalances());
					return;
				}
				res.writeHead(405, { allow: "POST" });
				res.end();
			}
		});
		return () => {
			disposeStatus();
			disposeBalance();
		};
	}, "dsh-buddy-checkin: status"));
}
//#endregion
export { apply, inject, name };
