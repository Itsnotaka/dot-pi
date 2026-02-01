/**
 * Format on Save Extension
 *
 * Tracks files edited/written by the agent during a turn. On agent_end,
 * runs the appropriate formatter based on project config detection.
 *
 * Formatter priority:
 *   JS/TS/CSS/MD: oxfmt (preferred) > prettier
 *   Python: ruff format
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { existsSync } from "fs";
import { extname, isAbsolute, resolve } from "path";

const FORMATTABLE_EXTS = new Set([
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

interface ToolCmd {
  cmd: string;
  args: string[];
}

function hasAnyFile(cwd: string, names: string[]): boolean {
  return names.some((n) => existsSync(resolve(cwd, n)));
}

export function detectFormatter(cwd: string): ToolCmd | null {
  if (hasAnyFile(cwd, [".oxfmtrc.json", ".oxfmtrc.jsonc"])) {
    return { cmd: "pnpm dlx", args: ["oxfmt"] };
  }
  if (
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
    return { cmd: "pnpm dlx", args: ["prettier", "--write"] };
  }
  return null;
}

export function detectPyFormatter(cwd: string): ToolCmd | null {
  if (hasAnyFile(cwd, ["ruff.toml", ".ruff.toml", "pyproject.toml"])) {
    return { cmd: "ruff", args: ["format"] };
  }
  return null;
}

export function partitionFiles(files: string[]): {
  formattable: string[];
  python: string[];
} {
  const formattable: string[] = [];
  const python: string[] = [];

  for (const f of files) {
    const ext = extname(f);
    if (FORMATTABLE_EXTS.has(ext)) formattable.push(f);
    else if (PY_EXTS.has(ext)) python.push(f);
  }

  return { formattable, python };
}

export default function (pi: ExtensionAPI) {
  const editedFiles = new Set<string>();

  pi.on("tool_result", async (event) => {
    if (event.isError) return;
    if (event.toolName === "edit" || event.toolName === "write") {
      const filePath = event.input?.path as string;
      if (filePath) editedFiles.add(filePath);
    }
  });

  pi.on("agent_start", async () => {
    editedFiles.clear();
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (editedFiles.size === 0) return;

    const cwd: string = ctx.cwd;
    const allFiles = [...editedFiles];
    editedFiles.clear();

    const resolved = allFiles
      .map((f) => (isAbsolute(f) ? f : resolve(cwd, f)))
      .filter((f) => existsSync(f));

    if (resolved.length === 0) return;

    const { formattable, python } = partitionFiles(resolved);

    if (formattable.length > 0) {
      const fmt = detectFormatter(cwd);
      if (fmt) {
        try {
          await pi.exec(fmt.cmd, [...fmt.args, ...formattable]);
        } catch {
          // formatter not installed — skip silently
        }
      }
    }

    if (python.length > 0) {
      const fmt = detectPyFormatter(cwd);
      if (fmt) {
        try {
          await pi.exec(fmt.cmd, [...fmt.args, ...python]);
        } catch {
          // formatter not installed — skip silently
        }
      }
    }

    if (ctx.hasUI) {
      ctx.ui.notify("Formatted ✓", "info");
    }
  });
}
