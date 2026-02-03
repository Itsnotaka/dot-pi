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
import {
  isEditToolResult,
  isWriteToolResult,
} from "@mariozechner/pi-coding-agent";

import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { dirname, extname, isAbsolute, join, parse, resolve } from "path";
import { fileURLToPath } from "url";

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

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));

function which(cmd: string): string | null {
  try {
    return execFileSync("which", [cmd], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

function findBinUpward(root: string, bin: string): string | null {
  let dir = root;
  const { root: fsRoot } = parse(dir);
  while (dir !== fsRoot) {
    const candidate = join(dir, "node_modules", ".bin", bin);
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  return null;
}

function resolveLocalOrGlobal(root: string, bin: string): string | null {
  return (
    findBinUpward(root, bin) ??
    findBinUpward(EXTENSION_DIR, bin) ??
    which(bin)
  );
}

function findVenvBinUpward(root: string, bin: string): string | null {
  let dir = root;
  const { root: fsRoot } = parse(dir);
  const isWin = process.platform === "win32";
  while (dir !== fsRoot) {
    const candidates = isWin
      ? [
          join(dir, ".venv", "Scripts", `${bin}.exe`),
          join(dir, ".venv", "Scripts", `${bin}.cmd`),
          join(dir, ".venv", "Scripts", bin),
        ]
      : [join(dir, ".venv", "bin", bin)];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
    dir = dirname(dir);
  }
  return null;
}

function resolvePythonBin(root: string, bin: string): string | null {
  return findVenvBinUpward(root, bin) ?? which(bin);
}

export function detectFormatter(cwd: string): ToolCmd | null {
  if (hasAnyFile(cwd, [".oxfmtrc.json", ".oxfmtrc.jsonc"])) {
    const oxfmt = resolveLocalOrGlobal(cwd, "oxfmt");
    if (oxfmt) return { cmd: oxfmt, args: [] };
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
    const prettier = resolveLocalOrGlobal(cwd, "prettier");
    if (prettier) return { cmd: prettier, args: ["--write"] };
  }
  return null;
}

export function detectPyFormatter(cwd: string): ToolCmd | null {
  if (hasAnyFile(cwd, ["ruff.toml", ".ruff.toml", "pyproject.toml"])) {
    const ruff = resolvePythonBin(cwd, "ruff");
    if (ruff) return { cmd: ruff, args: ["format"] };
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
    if (isEditToolResult(event) || isWriteToolResult(event)) {
      const filePath = event.input.path as string | undefined;
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
