/**
 * Format on Agent End Extension
 *
 * Tracks files edited/written by the agent during a turn. On agent_end,
 * runs the appropriate formatter + linter based on project config detection.
 *
 * Supported toolchains:
 *   JS/TS: oxfmt > prettier (format), oxlint > eslint (lint)
 *   Python: ruff format + ruff check --fix
 *
 * If lint errors remain after auto-fix, they are shown in the TUI and
 * sent back to the agent as a followUp message for self-correction.
 * A retry guard prevents infinite format→fix loops (max 1 retry).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync } from "fs";
import { extname, isAbsolute, resolve } from "path";

const JS_LINT_EXTS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".mts",
	".cts",
	".vue",
	".svelte",
	".astro",
]);
const JS_FMT_ONLY_EXTS = new Set([".json", ".jsonc", ".json5", ".css", ".scss", ".less", ".md", ".mdx"]);
const PY_EXTS = new Set([".py", ".pyi"]);

interface ToolCmd {
	cmd: string;
	args: string[];
}

interface ToolChain {
	formatter?: ToolCmd;
	linter?: ToolCmd;
}

function hasAnyFile(cwd: string, names: string[]): boolean {
	return names.some((n) => existsSync(resolve(cwd, n)));
}

export function detectJsToolchain(cwd: string): ToolChain {
	const chain: ToolChain = {};

	if (hasAnyFile(cwd, [".oxfmtrc.json", ".oxfmtrc.jsonc"])) {
		chain.formatter = { cmd: "npx", args: ["oxfmt"] };
	} else if (
		hasAnyFile(cwd, [
			".prettierrc",
			".prettierrc.json",
			".prettierrc.yaml",
			".prettierrc.yml",
			".prettierrc.js",
			".prettierrc.cjs",
			".prettierrc.mjs",
			"prettier.config.js",
			"prettier.config.cjs",
			"prettier.config.mjs",
		])
	) {
		chain.formatter = { cmd: "npx", args: ["prettier", "--write"] };
	}

	if (hasAnyFile(cwd, [".oxlintrc.json"])) {
		chain.linter = { cmd: "npx", args: ["oxlint", "--fix"] };
	} else if (
		hasAnyFile(cwd, [
			"eslint.config.js",
			"eslint.config.mjs",
			"eslint.config.cjs",
			"eslint.config.ts",
			"eslint.config.mts",
			"eslint.config.cts",
		])
	) {
		chain.linter = { cmd: "npx", args: ["eslint", "--fix"] };
	}

	return chain;
}

export function detectPyToolchain(cwd: string): ToolChain {
	if (hasAnyFile(cwd, ["ruff.toml", ".ruff.toml", "pyproject.toml"])) {
		return {
			formatter: { cmd: "ruff", args: ["format"] },
			linter: { cmd: "ruff", args: ["check", "--fix"] },
		};
	}
	return {};
}

export function partitionFiles(files: string[]): {
	jsFmtFiles: string[];
	jsLintFiles: string[];
	pyFiles: string[];
} {
	const jsFmtFiles: string[] = [];
	const jsLintFiles: string[] = [];
	const pyFiles: string[] = [];

	for (const f of files) {
		const ext = extname(f);
		if (JS_LINT_EXTS.has(ext)) {
			jsFmtFiles.push(f);
			jsLintFiles.push(f);
		} else if (JS_FMT_ONLY_EXTS.has(ext)) {
			jsFmtFiles.push(f);
		} else if (PY_EXTS.has(ext)) {
			pyFiles.push(f);
		}
	}

	return { jsFmtFiles, jsLintFiles, pyFiles };
}

const MAX_ERROR_LENGTH = 4000;

function truncateOutput(output: string): string {
	if (output.length <= MAX_ERROR_LENGTH) return output;
	return output.slice(0, MAX_ERROR_LENGTH) + "\n... (truncated)";
}

export default function (pi: ExtensionAPI) {
	const editedFiles = new Set<string>();
	let retryCount = 0;

	pi.on("tool_result", async (event: any) => {
		if (event.isError) return;
		if (event.toolName === "edit" || event.toolName === "write") {
			const filePath = event.input?.path as string;
			if (filePath) editedFiles.add(filePath);
		}
	});

	pi.on("agent_start", async () => {
		editedFiles.clear();
	});

	pi.on("agent_end", async (_event: any, ctx: any) => {
		if (editedFiles.size === 0) return;

		if (retryCount > 0) {
			retryCount = 0;
			editedFiles.clear();
			return;
		}

		const cwd: string = ctx.cwd;
		const allFiles = [...editedFiles];
		editedFiles.clear();

		const resolved = allFiles.map((f) => (isAbsolute(f) ? f : resolve(cwd, f))).filter((f) => existsSync(f));

		if (resolved.length === 0) return;

		const { jsFmtFiles, jsLintFiles, pyFiles } = partitionFiles(resolved);
		const errors: string[] = [];

		if (jsFmtFiles.length > 0 || jsLintFiles.length > 0) {
			const chain = detectJsToolchain(cwd);

			if (chain.formatter && jsFmtFiles.length > 0) {
				try {
					await pi.exec(chain.formatter.cmd, [...chain.formatter.args, ...jsFmtFiles]);
				} catch {
					// formatter not installed — skip silently
				}
			}

			if (chain.linter && jsLintFiles.length > 0) {
				try {
					const r = await pi.exec(chain.linter.cmd, [...chain.linter.args, ...jsLintFiles]);
					if (r.code !== 0) {
						const output = (r.stdout + "\n" + r.stderr).trim();
						if (output) {
							errors.push(`## JS/TS Lint Errors\n\`\`\`\n${truncateOutput(output)}\n\`\`\``);
						}
					}
				} catch {
					// linter not installed — skip silently
				}
			}
		}

		if (pyFiles.length > 0) {
			const chain = detectPyToolchain(cwd);

			if (chain.formatter) {
				try {
					await pi.exec(chain.formatter.cmd, [...chain.formatter.args, ...pyFiles]);
				} catch {
					// ruff not installed — skip silently
				}
			}

			if (chain.linter) {
				try {
					const r = await pi.exec(chain.linter.cmd, [...chain.linter.args, ...pyFiles]);
					if (r.code !== 0) {
						const output = (r.stdout + "\n" + r.stderr).trim();
						if (output) {
							errors.push(`## Python Lint Errors\n\`\`\`\n${truncateOutput(output)}\n\`\`\``);
						}
					}
				} catch {
					// ruff not installed — skip silently
				}
			}
		}

		if (errors.length > 0) {
			const errorMsg = errors.join("\n\n");

			if (ctx.hasUI) {
				ctx.ui.notify("Lint errors found after formatting — sending to agent", "warn");
			}

			retryCount++;
			pi.sendUserMessage(
				`The formatter/linter found errors in files you just edited. Please fix them:\n\n${errorMsg}`,
				{ deliverAs: "followUp" },
			);
		} else {
			retryCount = 0;
			if (ctx.hasUI) {
				ctx.ui.notify("Formatted & linted — all clean ✓", "info");
			}
		}
	});
}
