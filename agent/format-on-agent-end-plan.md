# Plan: Format/Lint on Agent End

## Context

**OpenCode approach**: Plugin with `tool.execute.after` / `file.edited` events.
Post-turn hook runs formatter, feeds lint errors back to agent via
`client.send()`.

**Pi approach**: Extension using `tool_result` + `agent_end` events. Same
pattern, native pi APIs. No core changes needed.

## Decisions

- **Auto-fix**: yes — run formatter with `--write`/`--fix`, then lint. If lint
  errors remain, feed back to agent via `followUp`.
- **TUI**: show errors as `ctx.ui.notify()` message so user sees them.
- **Scope**: oxfmt + oxlint (first-class), eslint, prettier, ruff (python).
  That's it.

---

## Tool Detection

Detect by config file presence in `ctx.cwd` (walk up not needed — just cwd).
First match wins per category (formatter vs linter). JS/TS and Python are
separate pipelines.

### JS/TS Pipeline

| Tool         | Role                 | Config files to detect                                                                          | Installed check                                 |
| ------------ | -------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **oxfmt**    | formatter            | `.oxfmtrc.json`, `.oxfmtrc.jsonc`                                                               | `npx oxfmt --help` or in `package.json` devDeps |
| **prettier** | formatter (fallback) | `.prettierrc`, `.prettierrc.*`, `prettier.config.*`                                             | `npx prettier --version`                        |
| **oxlint**   | linter               | `.oxlintrc.json`                                                                                | `npx oxlint --version`                          |
| **eslint**   | linter (fallback)    | `eslint.config.js`, `eslint.config.mjs`, `eslint.config.cjs`, `eslint.config.ts`, `.eslintrc.*` | `npx eslint --version`                          |

Priority: oxfmt > prettier for formatting, oxlint > eslint for linting.

### Python Pipeline

| Tool     | Role               | Config files to detect                                          | Installed check                          |
| -------- | ------------------ | --------------------------------------------------------------- | ---------------------------------------- |
| **ruff** | formatter + linter | `ruff.toml`, `.ruff.toml`, or `[tool.ruff]` in `pyproject.toml` | `ruff --version` or `uvx ruff --version` |

---

## CLI Commands

### oxfmt

```sh
# format (writes in place by default)
oxfmt <file1> <file2> ...
# check only (no write)
oxfmt --check <file1> <file2> ...
```

- Config: auto-detects `.oxfmtrc.json` / `.oxfmtrc.jsonc`
- Exit 0 = success

### oxlint

```sh
# lint with auto-fix
oxlint --fix <file1> <file2> ...
# lint + fix suggestions (may change behavior)
oxlint --fix-suggestions <file1> <file2> ...
# dangerous fixes
oxlint --fix-dangerously <file1> <file2> ...
```

- Config: auto-detects `.oxlintrc.json`
- Exit 0 = no violations, 1 = violations found

### prettier

```sh
prettier --write <file1> <file2> ...
```

- Exit 0 = success, 2 = error

### eslint

```sh
eslint --fix <file1> <file2> ...
```

- Config: auto-detects `eslint.config.*`
- Exit 0 = no errors, 1 = errors remain

### ruff

```sh
# format
ruff format <file1> <file2> ...
# lint + auto-fix
ruff check --fix <file1> <file2> ...
```

- Config: auto-detects `ruff.toml`, `.ruff.toml`, `pyproject.toml`
- `ruff format`: exit 0 always (unless config error = 2)
- `ruff check`: exit 0 = clean, 1 = violations remain

---

## File Extension Routing

| Extensions                                                   | Pipeline                        |
| ------------------------------------------------------------ | ------------------------------- |
| `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts`, `.cts` | JS/TS                           |
| `.json`, `.jsonc`, `.json5`                                  | JS/TS (formatter only, no lint) |
| `.css`, `.scss`, `.less`                                     | JS/TS (formatter only)          |
| `.md`, `.mdx`                                                | JS/TS (formatter only)          |
| `.vue`, `.svelte`, `.astro`                                  | JS/TS                           |
| `.py`, `.pyi`                                                | Python                          |

Files not matching any extension → skip silently.

---

## Event Flow

```
agent loop
  → tool_result (edit, path=foo.ts)  → track "foo.ts"
  → tool_result (write, path=bar.py) → track "bar.py"
  → tool_result (bash, ...)          → ignore
agent_end fires
  → partition files by pipeline (js/ts vs python)
  → filter out deleted files (fs.existsSync)
  → JS/TS pipeline:
      1. format: oxfmt <files> || prettier --write <files>
      2. lint+fix: oxlint --fix <files> || eslint --fix <files>
      3. if lint exit != 0 → collect stderr/stdout
  → Python pipeline:
      1. ruff format <files>
      2. ruff check --fix <files>
      3. if check exit != 0 → collect output
  → if any errors:
      - ctx.ui.notify("Format/lint errors found", "warn")
      - pi.sendMessage({ role: "user", content: error_output + "Fix these." }, { deliverAs: "followUp" })
  → clear tracked files
```

---

## Extension Structure

Single file: `~/.pi/agent/extensions/format-on-agent-end.ts`

### Pseudocode

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync } from "fs";
import { resolve, extname } from "path";

const JS_EXTS = new Set([
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
const JS_FMT_ONLY = new Set([
  ".json",
  ".jsonc",
  ".json5",
  ".css",
  ".scss",
  ".less",
  ".md",
  ".mdx",
]);
const PY_EXTS = new Set([".py", ".pyi"]);

interface ToolChain {
  formatter?: { cmd: string; args: string[] };
  linter?: { cmd: string; args: string[] };
}

async function detectJsToolchain(cwd: string, exec): Promise<ToolChain> {
  const chain: ToolChain = {};

  // formatter: oxfmt > prettier
  if (
    existsSync(resolve(cwd, ".oxfmtrc.json")) ||
    existsSync(resolve(cwd, ".oxfmtrc.jsonc"))
  ) {
    chain.formatter = { cmd: "npx", args: ["oxfmt"] };
  } else if (
    hasAny(cwd, [
      ".prettierrc",
      ".prettierrc.json",
      ".prettierrc.js",
      "prettier.config.js",
      "prettier.config.mjs",
    ])
  ) {
    chain.formatter = { cmd: "npx", args: ["prettier", "--write"] };
  }

  // linter: oxlint > eslint
  if (existsSync(resolve(cwd, ".oxlintrc.json"))) {
    chain.linter = { cmd: "npx", args: ["oxlint", "--fix"] };
  } else if (
    hasAny(cwd, [
      "eslint.config.js",
      "eslint.config.mjs",
      "eslint.config.cjs",
      "eslint.config.ts",
    ])
  ) {
    chain.linter = { cmd: "npx", args: ["eslint", "--fix"] };
  }

  return chain;
}

async function detectPyToolchain(cwd: string): Promise<ToolChain> {
  if (hasAny(cwd, ["ruff.toml", ".ruff.toml", "pyproject.toml"])) {
    return {
      formatter: { cmd: "ruff", args: ["format"] },
      linter: { cmd: "ruff", args: ["check", "--fix"] },
    };
  }
  return {};
}

export default function (pi: ExtensionAPI) {
  const editedFiles = new Set<string>();

  pi.on("tool_result", async (event) => {
    if (event.isError) return;
    if (event.toolName === "edit" || event.toolName === "write") {
      const path = (event.input as any)?.path as string;
      if (path) editedFiles.add(path);
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (editedFiles.size === 0) return;

    const allFiles = [...editedFiles];
    editedFiles.clear();

    // filter deleted
    const files = allFiles
      .map((f) => resolve(ctx.cwd, f))
      .filter((f) => existsSync(f));
    if (files.length === 0) return;

    // partition
    const jsFiles = files.filter(
      (f) => JS_EXTS.has(extname(f)) || JS_FMT_ONLY.has(extname(f))
    );
    const jsLintFiles = files.filter((f) => JS_EXTS.has(extname(f))); // no lint for json/css/md
    const pyFiles = files.filter((f) => PY_EXTS.has(extname(f)));

    const errors: string[] = [];

    // JS/TS pipeline
    if (jsFiles.length > 0 || jsLintFiles.length > 0) {
      const chain = await detectJsToolchain(ctx.cwd, pi.exec);

      if (chain.formatter && jsFiles.length > 0) {
        await pi.exec(chain.formatter.cmd, [
          ...chain.formatter.args,
          ...jsFiles,
        ]);
      }

      if (chain.linter && jsLintFiles.length > 0) {
        const r = await pi.exec(chain.linter.cmd, [
          ...chain.linter.args,
          ...jsLintFiles,
        ]);
        if (r.exitCode !== 0) {
          errors.push(
            `## JS/TS Lint Errors\n\`\`\`\n${(r.stdout + r.stderr).trim()}\n\`\`\``
          );
        }
      }
    }

    // Python pipeline
    if (pyFiles.length > 0) {
      const chain = await detectPyToolchain(ctx.cwd);

      if (chain.formatter) {
        await pi.exec(chain.formatter.cmd, [
          ...chain.formatter.args,
          ...pyFiles,
        ]);
      }

      if (chain.linter) {
        const r = await pi.exec(chain.linter.cmd, [
          ...chain.linter.args,
          ...pyFiles,
        ]);
        if (r.exitCode !== 0) {
          errors.push(
            `## Python Lint Errors\n\`\`\`\n${(r.stdout + r.stderr).trim()}\n\`\`\``
          );
        }
      }
    }

    // Report
    if (errors.length > 0) {
      const errorMsg = errors.join("\n\n");

      if (ctx.hasUI) {
        ctx.ui.notify(
          "Lint errors found after formatting — sending to agent",
          "warn"
        );
      }

      pi.sendMessage(
        {
          role: "user",
          content: `The formatter/linter found errors in files you edited. Fix them:\n\n${errorMsg}`,
        },
        { deliverAs: "followUp" }
      );
    } else {
      if (ctx.hasUI) {
        ctx.ui.notify("Formatted & linted — all clean ✓", "info");
      }
    }
  });
}
```

---

## Edge Cases

- **Deleted files**: `existsSync` check before running tools
- **Formatter not installed**: `npx` will fail; `pi.exec` returns non-zero.
  Treat as no-op with notify.
- **ruff not on PATH**: try `ruff` first, could fallback to `uvx ruff` (check
  `which ruff` first)
- **Mixed project**: both pipelines run independently, each on their own file
  set
- **Subagents**: separate pi processes, each has own extension instance — works
  automatically
- **agent_end fires even on abort**: check if files were actually modified (Set
  tracks only successful tool_results, so already safe)
- **npx cold start**: first run may be slow; acceptable since it's post-agent

## Remaining Questions

1. Should we also check `package.json` devDeps for oxfmt/oxlint/prettier/eslint
   presence (not just config files)?
2. For ruff: prefer `ruff` on PATH or `uvx ruff`? Could check `which ruff`
   first.
3. Max retry depth — if followUp triggers another agent_end with more lint
   errors, could loop. Cap at 1 retry? Use a `retryCount` guard.
