import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { type BashOperations, createBashTool } from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface SandboxConfig extends SandboxRuntimeConfig {
	enabled?: boolean;
	guard?: {
		enabled?: boolean;
	};
}

const DEFAULT_CONFIG: SandboxConfig = {
	enabled: true,
	guard: { enabled: true },
	network: {
		allowedDomains: [
			"npmjs.org",
			"*.npmjs.org",
			"registry.npmjs.org",
			"registry.yarnpkg.com",
			"pypi.org",
			"*.pypi.org",
			"github.com",
			"*.github.com",
			"api.github.com",
			"raw.githubusercontent.com",
		],
		deniedDomains: [],
	},
	filesystem: {
		denyRead: ["~/.ssh", "~/.aws", "~/.gnupg"],
		allowWrite: [".", "/tmp"],
		denyWrite: [".env", ".env.*", "*.pem", "*.key"],
	},
};

function loadConfig(cwd: string): SandboxConfig {
	const globalPath = join(homedir(), ".pi", "agent", "sandbox.json");
	const projectPath = join(cwd, ".pi", "sandbox.json");

	let global: Partial<SandboxConfig> = {};
	let project: Partial<SandboxConfig> = {};

	if (existsSync(globalPath)) {
		try {
			global = JSON.parse(readFileSync(globalPath, "utf-8"));
		} catch {}
	}
	if (existsSync(projectPath)) {
		try {
			project = JSON.parse(readFileSync(projectPath, "utf-8"));
		} catch {}
	}

	return deepMerge(deepMerge(DEFAULT_CONFIG, global), project);
}

function deepMerge(base: SandboxConfig, overrides: Partial<SandboxConfig>): SandboxConfig {
	const result: SandboxConfig = { ...base };
	if (overrides.enabled !== undefined) result.enabled = overrides.enabled;
	if (overrides.guard) result.guard = { ...base.guard, ...overrides.guard };
	if (overrides.network) result.network = { ...base.network, ...overrides.network };
	if (overrides.filesystem) result.filesystem = { ...base.filesystem, ...overrides.filesystem };

	const ext = overrides as { ignoreViolations?: Record<string, string[]>; enableWeakerNestedSandbox?: boolean };
	const out = result as { ignoreViolations?: Record<string, string[]>; enableWeakerNestedSandbox?: boolean };
	if (ext.ignoreViolations) out.ignoreViolations = ext.ignoreViolations;
	if (ext.enableWeakerNestedSandbox !== undefined) out.enableWeakerNestedSandbox = ext.enableWeakerNestedSandbox;

	return result;
}

// ---------------------------------------------------------------------------
// OS-level sandbox (filesystem + network enforcement)
// ---------------------------------------------------------------------------

function createSandboxedBashOps(): BashOperations {
	return {
		async exec(command, cwd, { onData, signal, timeout }) {
			if (!existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);

			const wrappedCommand = await SandboxManager.wrapWithSandbox(command);

			return new Promise((resolve, reject) => {
				const child = spawn("bash", ["-c", wrappedCommand], {
					cwd,
					detached: true,
					stdio: ["ignore", "pipe", "pipe"],
				});

				let timedOut = false;
				let timeoutHandle: NodeJS.Timeout | undefined;

				if (timeout !== undefined && timeout > 0) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						if (child.pid) {
							try {
								process.kill(-child.pid, "SIGKILL");
							} catch {
								child.kill("SIGKILL");
							}
						}
					}, timeout * 1000);
				}

				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);

				child.on("error", (err) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					reject(err);
				});

				const onAbort = () => {
					if (child.pid) {
						try {
							process.kill(-child.pid, "SIGKILL");
						} catch {
							child.kill("SIGKILL");
						}
					}
				};

				signal?.addEventListener("abort", onAbort, { once: true });

				child.on("close", (code) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					signal?.removeEventListener("abort", onAbort);

					if (signal?.aborted) reject(new Error("aborted"));
					else if (timedOut) reject(new Error(`timeout:${timeout}`));
					else resolve({ exitCode: code });
				});
			});
		},
	};
}

// ---------------------------------------------------------------------------
// Command guard (external side-effect rules only)
// ---------------------------------------------------------------------------

type Quote = "'" | '"' | "`";

interface CommandInfo {
	raw: string;
	tokens: string[];
	command: string | null;
	commandName: string | null;
	args: string[];
	sudo: boolean;
}

interface SegmentInfo {
	raw: string;
	pipeline: CommandInfo[];
}

interface GuardMatch {
	label: string;
	confirm: boolean;
}

function splitTopLevel(input: string): string[] {
	const parts: string[] = [];
	let current = "";
	let quote: Quote | null = null;
	let escape = false;

	const push = () => {
		const trimmed = current.trim();
		if (trimmed) parts.push(trimmed);
		current = "";
	};

	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (escape) { current += ch; escape = false; continue; }
		if (ch === "\\" && quote !== "'") { escape = true; current += ch; continue; }
		if (quote) { if (ch === quote) quote = null; current += ch; continue; }
		if (ch === "'" || ch === '"' || ch === "`") { quote = ch as Quote; current += ch; continue; }
		if (ch === "&" && input[i + 1] === "&") { push(); i++; continue; }
		if (ch === "|" && input[i + 1] === "|") { push(); i++; continue; }
		if (ch === ";" || ch === "\n") { push(); continue; }
		current += ch;
	}
	push();
	return parts;
}

function splitPipeline(input: string): string[] {
	const parts: string[] = [];
	let current = "";
	let quote: Quote | null = null;
	let escape = false;

	const push = () => {
		const trimmed = current.trim();
		if (trimmed) parts.push(trimmed);
		current = "";
	};

	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (escape) { current += ch; escape = false; continue; }
		if (ch === "\\" && quote !== "'") { escape = true; current += ch; continue; }
		if (quote) { if (ch === quote) quote = null; current += ch; continue; }
		if (ch === "'" || ch === '"' || ch === "`") { quote = ch as Quote; current += ch; continue; }
		if (ch === "|" && input[i + 1] !== "|") { push(); continue; }
		current += ch;
	}
	push();
	return parts;
}

function tokenize(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: Quote | null = null;
	let escape = false;

	const push = () => { if (current.length > 0) tokens.push(current); current = ""; };

	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (escape) { current += ch; escape = false; continue; }
		if (ch === "\\" && quote !== "'") { escape = true; continue; }
		if (quote) { if (ch === quote) { quote = null; continue; } current += ch; continue; }
		if (ch === "'" || ch === '"' || ch === "`") { quote = ch as Quote; continue; }
		if (/\s/.test(ch)) { push(); continue; }
		current += ch;
	}
	push();
	return tokens;
}

function isEnvAssignment(token: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function parseCommandInfo(raw: string): CommandInfo {
	const tokens = tokenize(raw);
	let idx = 0;
	let sudo = false;

	while (idx < tokens.length && isEnvAssignment(tokens[idx])) idx++;

	while (idx < tokens.length) {
		const token = tokens[idx];
		if (token === "sudo") {
			sudo = true;
			idx++;
			while (idx < tokens.length && tokens[idx].startsWith("-")) {
				if (tokens[idx] === "--") { idx++; break; }
				idx++;
			}
			continue;
		}
		if (token === "env") {
			idx++;
			while (idx < tokens.length) {
				const t = tokens[idx];
				if (t === "--") { idx++; break; }
				if (t.startsWith("-") || isEnvAssignment(t)) { idx++; continue; }
				break;
			}
			continue;
		}
		if (token === "command" || token === "time") { idx++; continue; }
		break;
	}

	const command = tokens[idx] ?? null;
	const args = command ? tokens.slice(idx + 1) : [];
	return { raw, tokens, command, commandName: command ? (command.split("/").pop() ?? command).toLowerCase() : null, args, sudo };
}

function parseSegment(raw: string): SegmentInfo {
	return { raw, pipeline: splitPipeline(raw).map(parseCommandInfo) };
}

function hasShortFlag(args: string[], flag: string): boolean {
	return args.some((a) => a.startsWith("-") && !a.startsWith("--") && a.includes(flag));
}

function hasLongFlag(args: string[], flag: string): boolean {
	const target = `--${flag}`;
	return args.some((a) => a === target || a.startsWith(`${target}=`));
}

function getFirstNonFlagArg(args: string[]): string | null {
	for (const a of args) { if (a === "--") continue; if (a.startsWith("-")) continue; return a; }
	return null;
}

function getNthNonFlagArg(args: string[], n: number): string | null {
	let seen = 0;
	for (const a of args) { if (a === "--" || a.startsWith("-")) continue; if (seen === n) return a; seen++; }
	return null;
}

function getGitSubcommand(args: string[]): { subcommand: string | null; rest: string[] } {
	const flagsWithValues = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--") return { subcommand: null, rest: [] };
		if (a.startsWith("-")) { if (flagsWithValues.has(a)) i++; continue; }
		return { subcommand: a, rest: args.slice(i + 1) };
	}
	return { subcommand: null, rest: [] };
}

const PIPE_FETCHERS = new Set(["curl", "wget"]);
const PIPE_INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "fish", "pwsh", "powershell", "python", "python3", "node", "ruby", "perl"]);

interface GuardRule {
	label: string;
	confirm: boolean;
	match: (cmd: CommandInfo, seg: SegmentInfo) => boolean;
}

const guardRules: GuardRule[] = [
	{
		label: "Git push",
		confirm: false,
		match: (cmd) => {
			if (cmd.commandName !== "git") return false;
			const { subcommand, rest } = getGitSubcommand(cmd.args);
			if (subcommand !== "push") return false;
			return !(hasLongFlag(rest, "force") || hasLongFlag(rest, "force-with-lease") || hasShortFlag(rest, "f"));
		},
	},
	{
		label: "Git force push",
		confirm: true,
		match: (cmd) => {
			if (cmd.commandName !== "git") return false;
			const { subcommand, rest } = getGitSubcommand(cmd.args);
			if (subcommand !== "push") return false;
			return hasLongFlag(rest, "force") || hasLongFlag(rest, "force-with-lease") || hasShortFlag(rest, "f");
		},
	},
	{
		label: "Package publish",
		confirm: true,
		match: (cmd) => {
			if (!cmd.commandName) return false;
			if (!["npm", "pnpm", "yarn", "bun"].includes(cmd.commandName)) return false;
			const sub = getFirstNonFlagArg(cmd.args);
			if (sub === "run" || sub === "exec") return false;
			return cmd.args.includes("publish") || sub === "publish";
		},
	},
	{
		label: "npm unpublish/deprecate",
		confirm: true,
		match: (cmd) => {
			if (cmd.commandName !== "npm") return false;
			const sub = getFirstNonFlagArg(cmd.args);
			return sub === "unpublish" || sub === "deprecate";
		},
	},
	{
		label: "PyPI publish",
		confirm: true,
		match: (cmd) => cmd.commandName === "twine" && cmd.args.includes("upload"),
	},
	{
		label: "Cargo publish",
		confirm: true,
		match: (cmd) => cmd.commandName === "cargo" && (cmd.args.includes("publish") || cmd.args.includes("yank")),
	},
	{
		label: "Gem publish",
		confirm: true,
		match: (cmd) => cmd.commandName === "gem" && cmd.args.includes("push"),
	},
	{
		label: "Deploy",
		confirm: false,
		match: (cmd) => {
			if (!cmd.commandName) return false;
			if (cmd.commandName === "vercel") {
				const sub = getFirstNonFlagArg(cmd.args);
				return !sub || sub === "deploy" || cmd.args.includes("--prod");
			}
			if (["netlify", "firebase", "fly", "flyctl", "railway"].includes(cmd.commandName)) {
				return cmd.args.includes("deploy") || cmd.args.includes("up");
			}
			return false;
		},
	},
	{
		label: "Terraform mutation",
		confirm: true,
		match: (cmd) => {
			if (cmd.commandName !== "terraform") return false;
			const sub = getFirstNonFlagArg(cmd.args);
			return sub === "apply" || sub === "destroy" || sub === "import";
		},
	},
	{
		label: "Pulumi mutation",
		confirm: true,
		match: (cmd) => {
			if (cmd.commandName !== "pulumi") return false;
			const sub = getFirstNonFlagArg(cmd.args);
			return sub === "up" || sub === "destroy";
		},
	},
	{
		label: "Kubectl mutation",
		confirm: false,
		match: (cmd) => {
			if (cmd.commandName !== "kubectl") return false;
			const sub = getFirstNonFlagArg(cmd.args);
			return sub === "apply" || sub === "delete" || sub === "patch" || sub === "replace" || sub === "scale";
		},
	},
	{
		label: "Helm mutation",
		confirm: false,
		match: (cmd) => {
			if (cmd.commandName !== "helm") return false;
			const sub = getFirstNonFlagArg(cmd.args);
			return sub === "install" || sub === "upgrade" || sub === "uninstall" || sub === "delete";
		},
	},
	{
		label: "Docker push",
		confirm: true,
		match: (cmd) => cmd.commandName === "docker" && cmd.args.includes("push"),
	},
	{
		label: "Docker compose (foreground)",
		confirm: false,
		match: (cmd) => {
			if (cmd.commandName === "docker") {
				const sub = getNthNonFlagArg(cmd.args, 0);
				const sub2 = getNthNonFlagArg(cmd.args, 1);
				return sub === "compose" && sub2 === "up" && !cmd.args.includes("-d") && !cmd.args.includes("--detach");
			}
			if (cmd.commandName === "docker-compose") {
				const sub = getNthNonFlagArg(cmd.args, 0);
				return sub === "up" && !cmd.args.includes("-d") && !cmd.args.includes("--detach");
			}
			return false;
		},
	},
	{
		label: "AWS destructive",
		confirm: false,
		match: (cmd) => cmd.commandName === "aws" && cmd.args.some((a) => /\b(delete|terminate|destroy|rm|purge)\b/.test(a)),
	},
	{
		label: "Pipe to interpreter",
		confirm: true,
		match: (_cmd, seg) => {
			let sawFetcher = false;
			for (const part of seg.pipeline) {
				if (!part.commandName) continue;
				if (PIPE_FETCHERS.has(part.commandName)) sawFetcher = true;
				if (sawFetcher && PIPE_INTERPRETERS.has(part.commandName)) return true;
			}
			return false;
		},
	},
	{
		label: "GitHub CLI mutation",
		confirm: false,
		match: (cmd) => {
			if (cmd.commandName !== "gh") return false;
			const sub = getFirstNonFlagArg(cmd.args);
			if (sub === "pr") return cmd.args.includes("merge") || cmd.args.includes("close");
			if (sub === "repo") return cmd.args.includes("create") || cmd.args.includes("delete");
			if (sub === "release") return cmd.args.includes("create") || cmd.args.includes("delete");
			if (sub === "api") return cmd.args.some((a) => /^-X\s*(POST|PUT|PATCH|DELETE)$/i.test(a) || /^--method$/i.test(a));
			return false;
		},
	},
];

const ALLOW_ENTRY_TYPE = "sandbox-guard.allow";
const DANGEROUSLY_ALLOW_FLAG = "dangerouslyAllowCommands";
const DANGEROUSLY_ALLOW_PHRASE = "DANGEROUSLY_ALLOW";

function normalizeCommand(command: string): string {
	return command.trim().replace(/\s+/g, " ");
}

function evaluateCommand(command: string): GuardMatch[] {
	const matches: GuardMatch[] = [];
	const segments = splitTopLevel(command).map(parseSegment);

	for (const seg of segments) {
		for (const part of seg.pipeline) {
			for (const rule of guardRules) {
				if (rule.match(part, seg)) {
					matches.push({ label: rule.label, confirm: rule.confirm });
				}
			}
		}
	}
	return matches;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerFlag("no-sandbox", {
		description: "Disable OS-level sandboxing for bash commands",
		type: "boolean",
		default: false,
	});

	pi.registerFlag(DANGEROUSLY_ALLOW_FLAG, {
		description: "Bypass command guard prompts",
		type: "boolean",
		default: false,
	});

	const localCwd = process.cwd();
	const localBash = createBashTool(localCwd);

	let sandboxEnabled = false;
	let sandboxInitialized = false;
	let guardEnabled = true;

	const allowedCommands = new Set<string>();

	function loadAllowlist(ctx: ExtensionContext) {
		allowedCommands.clear();
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== ALLOW_ENTRY_TYPE) continue;
			const data = entry.data as { command?: unknown } | undefined;
			if (typeof data?.command === "string") allowedCommands.add(normalizeCommand(data.command));
		}
	}

	// Sandboxed bash tool (replaces built-in bash)
	pi.registerTool({
		...localBash,
		label: "bash (sandboxed)",
		async execute(id, params, onUpdate, _ctx, signal) {
			if (!sandboxEnabled || !sandboxInitialized) {
				return localBash.execute(id, params, signal, onUpdate);
			}
			const sandboxedBash = createBashTool(localCwd, { operations: createSandboxedBashOps() });
			return sandboxedBash.execute(id, params, signal, onUpdate);
		},
	});

	// Sandbox user bash (! and !! commands) too
	pi.on("user_bash", () => {
		if (!sandboxEnabled || !sandboxInitialized) return;
		return { operations: createSandboxedBashOps() };
	});

	// Command guard for external side effects
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return;
		if (!guardEnabled) return;
		if (pi.getFlag(DANGEROUSLY_ALLOW_FLAG) === true) return;

		const cmd = (event.input as Record<string, unknown>).command as string;
		if (!cmd) return;

		const normalized = normalizeCommand(cmd);
		if (allowedCommands.has(normalized)) return;

		const matches = evaluateCommand(cmd);
		if (matches.length === 0) return;

		const labels = Array.from(new Set(matches.map((m) => m.label)));
		const tag = labels.join(", ");
		const needsTypedConfirm = matches.some((m) => m.confirm);

		if (!ctx.hasUI) {
			return { block: true, reason: `Blocked (no UI): ${tag}. Use --${DANGEROUSLY_ALLOW_FLAG} to bypass.` };
		}

		if (needsTypedConfirm) {
			const response = await ctx.ui.input(`⚠️ ${tag}\n${cmd}`, `Type ${DANGEROUSLY_ALLOW_PHRASE} to allow`);
			if (response !== DANGEROUSLY_ALLOW_PHRASE) {
				return { block: true, reason: `User rejected command (${tag})` };
			}
			allowedCommands.add(normalized);
			pi.appendEntry(ALLOW_ENTRY_TYPE, { command: normalized });
			return;
		}

		const allowed = await ctx.ui.confirm(`⚠️ ${tag}`, cmd);
		if (!allowed) {
			return { block: true, reason: `User rejected command (${tag})` };
		}
	});

	// Lifecycle
	pi.on("session_start", async (_event, ctx) => {
		loadAllowlist(ctx);

		const noSandbox = pi.getFlag("no-sandbox") as boolean;
		const config = loadConfig(ctx.cwd);

		guardEnabled = config.guard?.enabled !== false;

		if (noSandbox || !config.enabled) {
			sandboxEnabled = false;
			if (noSandbox) ctx.ui.notify("Sandbox disabled via --no-sandbox", "warning");
			return;
		}

		const platform = process.platform;
		if (platform !== "darwin" && platform !== "linux") {
			sandboxEnabled = false;
			ctx.ui.notify(`Sandbox not supported on ${platform}`, "warning");
			return;
		}

		try {
			const ext = config as unknown as { ignoreViolations?: Record<string, string[]>; enableWeakerNestedSandbox?: boolean };
			await SandboxManager.initialize({
				network: config.network,
				filesystem: config.filesystem,
				ignoreViolations: ext.ignoreViolations,
				enableWeakerNestedSandbox: ext.enableWeakerNestedSandbox,
			});

			sandboxEnabled = true;
			sandboxInitialized = true;

			const networkCount = config.network?.allowedDomains?.length ?? 0;
			const writeCount = config.filesystem?.allowWrite?.length ?? 0;
			ctx.ui.setStatus(
				"sandbox",
				ctx.ui.theme.fg("accent", `🔒 Sandbox: ${networkCount} domains, ${writeCount} write paths`),
			);
		} catch (err) {
			sandboxEnabled = false;
			ctx.ui.notify(`Sandbox init failed: ${err instanceof Error ? err.message : err}`, "error");
		}
	});

	pi.on("session_switch", async (_event, ctx) => {
		loadAllowlist(ctx);
	});

	pi.on("session_shutdown", async () => {
		if (sandboxInitialized) {
			try { await SandboxManager.reset(); } catch {}
		}
	});

	// /sandbox command to inspect config
	pi.registerCommand("sandbox", {
		description: "Show sandbox configuration",
		handler: async (_args, ctx) => {
			const config = loadConfig(ctx.cwd);
			const lines = [
				`OS sandbox: ${sandboxEnabled ? "enabled" : "disabled"}`,
				`Command guard: ${guardEnabled ? "enabled" : "disabled"}`,
				"",
				"Network:",
				`  Allowed: ${config.network?.allowedDomains?.join(", ") || "(none)"}`,
				`  Denied: ${config.network?.deniedDomains?.join(", ") || "(none)"}`,
				"",
				"Filesystem:",
				`  Deny Read: ${config.filesystem?.denyRead?.join(", ") || "(none)"}`,
				`  Allow Write: ${config.filesystem?.allowWrite?.join(", ") || "(none)"}`,
				`  Deny Write: ${config.filesystem?.denyWrite?.join(", ") || "(none)"}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
