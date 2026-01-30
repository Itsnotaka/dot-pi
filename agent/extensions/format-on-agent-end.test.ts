import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
	detectJsToolchain,
	detectPyToolchain,
	partitionFiles,
} from "./format-on-agent-end.ts";

// We also test the full extension by simulating the event lifecycle with a mock ExtensionAPI.

function makeTmpDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-fmt-test-"));
	return dir;
}

describe("partitionFiles", () => {
	it("routes .ts and .tsx to both js fmt and lint", () => {
		const result = partitionFiles(["/a/foo.ts", "/a/bar.tsx"]);
		assert.deepEqual(result.jsFmtFiles, ["/a/foo.ts", "/a/bar.tsx"]);
		assert.deepEqual(result.jsLintFiles, ["/a/foo.ts", "/a/bar.tsx"]);
		assert.deepEqual(result.pyFiles, []);
	});

	it("routes .json/.jsonc/.json5 to fmt-only (no lint)", () => {
		const result = partitionFiles(["/a/config.json", "/a/tsconfig.jsonc", "/a/data.json5"]);
		assert.deepEqual(result.jsFmtFiles, ["/a/config.json", "/a/tsconfig.jsonc", "/a/data.json5"]);
		assert.deepEqual(result.jsLintFiles, []);
		assert.deepEqual(result.pyFiles, []);
	});

	it("routes .css/.md to fmt-only", () => {
		const result = partitionFiles(["/a/style.css", "/a/README.md"]);
		assert.deepEqual(result.jsFmtFiles, ["/a/style.css", "/a/README.md"]);
		assert.deepEqual(result.jsLintFiles, []);
	});

	it("routes .py/.pyi to python pipeline", () => {
		const result = partitionFiles(["/a/main.py", "/a/types.pyi"]);
		assert.deepEqual(result.jsFmtFiles, []);
		assert.deepEqual(result.jsLintFiles, []);
		assert.deepEqual(result.pyFiles, ["/a/main.py", "/a/types.pyi"]);
	});

	it("skips unknown extensions", () => {
		const result = partitionFiles(["/a/image.png", "/a/data.csv", "/a/Makefile"]);
		assert.deepEqual(result.jsFmtFiles, []);
		assert.deepEqual(result.jsLintFiles, []);
		assert.deepEqual(result.pyFiles, []);
	});

	it("handles mixed files across pipelines", () => {
		const result = partitionFiles(["/a/app.tsx", "/a/config.json", "/a/script.py", "/a/pic.png"]);
		assert.deepEqual(result.jsFmtFiles, ["/a/app.tsx", "/a/config.json"]);
		assert.deepEqual(result.jsLintFiles, ["/a/app.tsx"]);
		assert.deepEqual(result.pyFiles, ["/a/script.py"]);
	});

	it("routes .vue/.svelte/.astro to js fmt + lint", () => {
		const result = partitionFiles(["/a/App.vue", "/a/Page.svelte", "/a/Layout.astro"]);
		assert.deepEqual(result.jsFmtFiles, ["/a/App.vue", "/a/Page.svelte", "/a/Layout.astro"]);
		assert.deepEqual(result.jsLintFiles, ["/a/App.vue", "/a/Page.svelte", "/a/Layout.astro"]);
	});
});

describe("detectJsToolchain", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = makeTmpDir();
	});

	it("returns empty when no config files present", () => {
		const chain = detectJsToolchain(cwd);
		assert.equal(chain.formatter, undefined);
		assert.equal(chain.linter, undefined);
	});

	it("detects oxfmt from .oxfmtrc.json", () => {
		writeFileSync(join(cwd, ".oxfmtrc.json"), "{}");
		const chain = detectJsToolchain(cwd);
		assert.deepEqual(chain.formatter, { cmd: "npx", args: ["oxfmt"] });
	});

	it("detects oxfmt from .oxfmtrc.jsonc", () => {
		writeFileSync(join(cwd, ".oxfmtrc.jsonc"), "{}");
		const chain = detectJsToolchain(cwd);
		assert.deepEqual(chain.formatter, { cmd: "npx", args: ["oxfmt"] });
	});

	it("detects prettier from .prettierrc", () => {
		writeFileSync(join(cwd, ".prettierrc"), "{}");
		const chain = detectJsToolchain(cwd);
		assert.deepEqual(chain.formatter, { cmd: "npx", args: ["prettier", "--write"] });
	});

	it("detects prettier from prettier.config.mjs", () => {
		writeFileSync(join(cwd, "prettier.config.mjs"), "export default {}");
		const chain = detectJsToolchain(cwd);
		assert.deepEqual(chain.formatter, { cmd: "npx", args: ["prettier", "--write"] });
	});

	it("prefers oxfmt over prettier when both exist", () => {
		writeFileSync(join(cwd, ".oxfmtrc.json"), "{}");
		writeFileSync(join(cwd, ".prettierrc"), "{}");
		const chain = detectJsToolchain(cwd);
		assert.deepEqual(chain.formatter, { cmd: "npx", args: ["oxfmt"] });
	});

	it("detects oxlint from .oxlintrc.json", () => {
		writeFileSync(join(cwd, ".oxlintrc.json"), "{}");
		const chain = detectJsToolchain(cwd);
		assert.deepEqual(chain.linter, { cmd: "npx", args: ["oxlint", "--fix"] });
	});

	it("detects eslint from eslint.config.js", () => {
		writeFileSync(join(cwd, "eslint.config.js"), "module.exports = []");
		const chain = detectJsToolchain(cwd);
		assert.deepEqual(chain.linter, { cmd: "npx", args: ["eslint", "--fix"] });
	});

	it("detects eslint from eslint.config.mjs", () => {
		writeFileSync(join(cwd, "eslint.config.mjs"), "export default []");
		const chain = detectJsToolchain(cwd);
		assert.deepEqual(chain.linter, { cmd: "npx", args: ["eslint", "--fix"] });
	});

	it("detects eslint from eslint.config.ts", () => {
		writeFileSync(join(cwd, "eslint.config.ts"), "export default []");
		const chain = detectJsToolchain(cwd);
		assert.deepEqual(chain.linter, { cmd: "npx", args: ["eslint", "--fix"] });
	});

	it("prefers oxlint over eslint when both exist", () => {
		writeFileSync(join(cwd, ".oxlintrc.json"), "{}");
		writeFileSync(join(cwd, "eslint.config.js"), "module.exports = []");
		const chain = detectJsToolchain(cwd);
		assert.deepEqual(chain.linter, { cmd: "npx", args: ["oxlint", "--fix"] });
	});

	it("detects both formatter and linter independently", () => {
		writeFileSync(join(cwd, ".prettierrc"), "{}");
		writeFileSync(join(cwd, ".oxlintrc.json"), "{}");
		const chain = detectJsToolchain(cwd);
		assert.deepEqual(chain.formatter, { cmd: "npx", args: ["prettier", "--write"] });
		assert.deepEqual(chain.linter, { cmd: "npx", args: ["oxlint", "--fix"] });
	});
});

describe("detectPyToolchain", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = makeTmpDir();
	});

	it("returns empty when no config files present", () => {
		const chain = detectPyToolchain(cwd);
		assert.equal(chain.formatter, undefined);
		assert.equal(chain.linter, undefined);
	});

	it("detects ruff from ruff.toml", () => {
		writeFileSync(join(cwd, "ruff.toml"), "");
		const chain = detectPyToolchain(cwd);
		assert.deepEqual(chain.formatter, { cmd: "ruff", args: ["format"] });
		assert.deepEqual(chain.linter, { cmd: "ruff", args: ["check", "--fix"] });
	});

	it("detects ruff from .ruff.toml", () => {
		writeFileSync(join(cwd, ".ruff.toml"), "");
		const chain = detectPyToolchain(cwd);
		assert.deepEqual(chain.formatter, { cmd: "ruff", args: ["format"] });
	});

	it("detects ruff from pyproject.toml", () => {
		writeFileSync(join(cwd, "pyproject.toml"), "[tool.ruff]\nline-length = 88\n");
		const chain = detectPyToolchain(cwd);
		assert.deepEqual(chain.formatter, { cmd: "ruff", args: ["format"] });
		assert.deepEqual(chain.linter, { cmd: "ruff", args: ["check", "--fix"] });
	});
});

describe("extension lifecycle (integration)", () => {
	let cwd: string;
	let handlers: Map<string, Function>;
	let execCalls: Array<{ cmd: string; args: string[] }>;
	let notifications: Array<{ msg: string; level: string }>;
	let sentMessages: Array<{ content: string; options: any }>;

	function createMockPi() {
		handlers = new Map();
		execCalls = [];
		notifications = [];
		sentMessages = [];

		return {
			on(event: string, handler: Function) {
				handlers.set(event, handler);
			},
			async exec(cmd: string, args: string[]) {
				execCalls.push({ cmd, args });
				return { stdout: "", stderr: "", code: 0, killed: false };
			},
			sendUserMessage(content: string, options: any) {
				sentMessages.push({ content, options });
			},
		};
	}

	function createMockCtx(cwdPath: string) {
		return {
			cwd: cwdPath,
			hasUI: true,
			ui: {
				notify(msg: string, level: string) {
					notifications.push({ msg, level });
				},
			},
		};
	}

	// Each test gets a fresh module instance to avoid shared retryCount / editedFiles state.
	let testSeq = 0;
	async function loadExtension() {
		testSeq++;
		const mod = await import(`./format-on-agent-end.ts?v=${testSeq}`);
		return mod.default;
	}

	beforeEach(() => {
		cwd = makeTmpDir();
	});

	it("tracks edited files and runs formatter + linter on agent_end", async () => {
		writeFileSync(join(cwd, ".oxfmtrc.json"), "{}");
		writeFileSync(join(cwd, ".oxlintrc.json"), "{}");
		writeFileSync(join(cwd, "foo.ts"), "const x = 1;");

		const mockPi = createMockPi();
		const setup = await loadExtension();
		setup(mockPi as any);

		const ctx = createMockCtx(cwd);

		await handlers.get("agent_start")!({}, ctx);
		await handlers.get("tool_result")!({
			isError: false,
			toolName: "edit",
			input: { path: join(cwd, "foo.ts") },
		}, ctx);
		await handlers.get("agent_end")!({}, ctx);

		assert.equal(execCalls.length, 2);
		assert.equal(execCalls[0].cmd, "npx");
		assert.deepEqual(execCalls[0].args[0], "oxfmt");
		assert.equal(execCalls[1].cmd, "npx");
		assert.equal(execCalls[1].args[0], "oxlint");
		assert.equal(execCalls[1].args[1], "--fix");
		assert.equal(notifications.length, 1);
		assert.ok(notifications[0].msg.includes("all clean"));
		assert.equal(notifications[0].level, "info");
	});

	it("sends followUp when linter returns errors", async () => {
		writeFileSync(join(cwd, ".oxlintrc.json"), "{}");
		writeFileSync(join(cwd, "bar.ts"), "const x = 1;");

		const mockPi = createMockPi();
		// Override exec to return lint error
		mockPi.exec = async (cmd: string, args: string[]) => {
			execCalls.push({ cmd, args });
			if (args.includes("--fix")) {
				return { stdout: "error: no-unused-vars", stderr: "", code: 1, killed: false };
			}
			return { stdout: "", stderr: "", code: 0, killed: false };
		};

		const setup = await loadExtension();
		setup(mockPi as any);

		const ctx = createMockCtx(cwd);

		await handlers.get("agent_start")!({}, ctx);
		await handlers.get("tool_result")!({
			isError: false,
			toolName: "write",
			input: { path: join(cwd, "bar.ts") },
		}, ctx);
		await handlers.get("agent_end")!({}, ctx);

		assert.equal(sentMessages.length, 1);
		assert.ok(sentMessages[0].content.includes("no-unused-vars"));
		assert.deepEqual(sentMessages[0].options, { deliverAs: "followUp" });
		assert.equal(notifications.length, 1);
		assert.equal(notifications[0].level, "warn");
	});

	it("skips deleted files", async () => {
		writeFileSync(join(cwd, ".oxfmtrc.json"), "{}");
		// Don't create the file — simulates deletion after edit

		const mockPi = createMockPi();
		const setup = await loadExtension();
		setup(mockPi as any);

		const ctx = createMockCtx(cwd);

		await handlers.get("agent_start")!({}, ctx);
		await handlers.get("tool_result")!({
			isError: false,
			toolName: "edit",
			input: { path: join(cwd, "deleted.ts") },
		}, ctx);
		await handlers.get("agent_end")!({}, ctx);

		assert.equal(execCalls.length, 0);
		assert.equal(notifications.length, 0);
	});

	it("does nothing when no files were edited", async () => {
		const mockPi = createMockPi();
		const setup = await loadExtension();
		setup(mockPi as any);

		const ctx = createMockCtx(cwd);

		await handlers.get("agent_start")!({}, ctx);
		await handlers.get("agent_end")!({}, ctx);

		assert.equal(execCalls.length, 0);
		assert.equal(notifications.length, 0);
	});

	it("does not track errored tool results", async () => {
		writeFileSync(join(cwd, ".oxfmtrc.json"), "{}");

		const mockPi = createMockPi();
		const setup = await loadExtension();
		setup(mockPi as any);

		const ctx = createMockCtx(cwd);

		await handlers.get("agent_start")!({}, ctx);
		await handlers.get("tool_result")!({
			isError: true,
			toolName: "edit",
			input: { path: join(cwd, "fail.ts") },
		}, ctx);
		await handlers.get("agent_end")!({}, ctx);

		assert.equal(execCalls.length, 0);
	});

	it("ignores non-edit/write tools", async () => {
		const mockPi = createMockPi();
		const setup = await loadExtension();
		setup(mockPi as any);

		const ctx = createMockCtx(cwd);

		await handlers.get("agent_start")!({}, ctx);
		await handlers.get("tool_result")!({
			isError: false,
			toolName: "bash",
			input: { command: "echo hi" },
		}, ctx);
		await handlers.get("tool_result")!({
			isError: false,
			toolName: "read",
			input: { path: "/some/file.ts" },
		}, ctx);
		await handlers.get("agent_end")!({}, ctx);

		assert.equal(execCalls.length, 0);
	});

	it("runs python pipeline for .py files", async () => {
		writeFileSync(join(cwd, "ruff.toml"), "");
		writeFileSync(join(cwd, "main.py"), "x = 1\n");

		const mockPi = createMockPi();
		const setup = await loadExtension();
		setup(mockPi as any);

		const ctx = createMockCtx(cwd);

		await handlers.get("agent_start")!({}, ctx);
		await handlers.get("tool_result")!({
			isError: false,
			toolName: "write",
			input: { path: join(cwd, "main.py") },
		}, ctx);
		await handlers.get("agent_end")!({}, ctx);

		assert.equal(execCalls.length, 2);
		assert.equal(execCalls[0].cmd, "ruff");
		assert.deepEqual(execCalls[0].args[0], "format");
		assert.equal(execCalls[1].cmd, "ruff");
		assert.equal(execCalls[1].args[0], "check");
		assert.equal(execCalls[1].args[1], "--fix");
	});

	it("runs both pipelines for mixed js + python edits", async () => {
		writeFileSync(join(cwd, ".oxfmtrc.json"), "{}");
		writeFileSync(join(cwd, "ruff.toml"), "");
		writeFileSync(join(cwd, "app.ts"), "const x = 1;");
		writeFileSync(join(cwd, "main.py"), "x = 1\n");

		const mockPi = createMockPi();
		const setup = await loadExtension();
		setup(mockPi as any);

		const ctx = createMockCtx(cwd);

		await handlers.get("agent_start")!({}, ctx);
		await handlers.get("tool_result")!({
			isError: false, toolName: "edit",
			input: { path: join(cwd, "app.ts") },
		}, ctx);
		await handlers.get("tool_result")!({
			isError: false, toolName: "write",
			input: { path: join(cwd, "main.py") },
		}, ctx);
		await handlers.get("agent_end")!({}, ctx);

		const cmds = execCalls.map((c) => `${c.cmd} ${c.args[0]}`);
		assert.ok(cmds.includes("npx oxfmt"), "should run oxfmt");
		assert.ok(cmds.includes("ruff format"), "should run ruff format");
		assert.ok(cmds.includes("ruff check"), "should run ruff check");
	});

	it("formats json/jsonc without linting", async () => {
		writeFileSync(join(cwd, ".oxfmtrc.json"), "{}");
		writeFileSync(join(cwd, ".oxlintrc.json"), "{}");
		writeFileSync(join(cwd, "config.json"), "{}");

		const mockPi = createMockPi();
		const setup = await loadExtension();
		setup(mockPi as any);

		const ctx = createMockCtx(cwd);

		await handlers.get("agent_start")!({}, ctx);
		await handlers.get("tool_result")!({
			isError: false, toolName: "write",
			input: { path: join(cwd, "config.json") },
		}, ctx);
		await handlers.get("agent_end")!({}, ctx);

		assert.equal(execCalls.length, 1, "should only run formatter, not linter");
		assert.equal(execCalls[0].cmd, "npx");
		assert.equal(execCalls[0].args[0], "oxfmt");
	});

	it("caps retry at 1 to prevent infinite loops", async () => {
		writeFileSync(join(cwd, ".oxlintrc.json"), "{}");
		writeFileSync(join(cwd, "loop.ts"), "const x = 1;");

		const mockPi = createMockPi();
		mockPi.exec = async (cmd: string, args: string[]) => {
			execCalls.push({ cmd, args });
			if (args.includes("--fix")) {
				return { stdout: "error: some-rule", stderr: "", code: 1, killed: false };
			}
			return { stdout: "", stderr: "", code: 0, killed: false };
		};

		const setup = await loadExtension();
		setup(mockPi as any);

		const ctx = createMockCtx(cwd);

		// First run — should send followUp
		await handlers.get("agent_start")!({}, ctx);
		await handlers.get("tool_result")!({
			isError: false, toolName: "edit",
			input: { path: join(cwd, "loop.ts") },
		}, ctx);
		await handlers.get("agent_end")!({}, ctx);

		assert.equal(sentMessages.length, 1, "first run sends followUp");

		// Simulate the retry agent run
		execCalls.length = 0;
		notifications.length = 0;

		await handlers.get("agent_start")!({}, ctx);
		await handlers.get("tool_result")!({
			isError: false, toolName: "edit",
			input: { path: join(cwd, "loop.ts") },
		}, ctx);
		await handlers.get("agent_end")!({}, ctx);

		assert.equal(execCalls.length, 0, "second run skips — retry guard");
		assert.equal(sentMessages.length, 1, "no additional followUp sent");
	});

	it("skips when no toolchain detected", async () => {
		// No config files in cwd
		writeFileSync(join(cwd, "foo.ts"), "const x = 1;");

		const mockPi = createMockPi();
		const setup = await loadExtension();
		setup(mockPi as any);

		const ctx = createMockCtx(cwd);

		await handlers.get("agent_start")!({}, ctx);
		await handlers.get("tool_result")!({
			isError: false, toolName: "edit",
			input: { path: join(cwd, "foo.ts") },
		}, ctx);
		await handlers.get("agent_end")!({}, ctx);

		assert.equal(execCalls.length, 0);
	});
});
