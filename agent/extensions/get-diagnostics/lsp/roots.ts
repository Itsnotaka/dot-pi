import { existsSync } from "fs";
import { dirname, join, parse } from "path";

const TS_MARKERS = [
  "tsconfig.json",
  "jsconfig.json",
  "package.json",
  "package-lock.json",
  "bun.lockb",
  "pnpm-lock.yaml",
  "yarn.lock",
];

const PY_MARKERS = [
  "pyproject.toml",
  "ty.toml",
  "setup.py",
  "setup.cfg",
  "requirements.txt",
  "Pipfile",
];

function findRoot(file: string, markers: string[]): string | null {
  let dir = dirname(file);
  const { root } = parse(dir);
  while (dir !== root) {
    for (const marker of markers) {
      if (existsSync(join(dir, marker))) return dir;
    }
    dir = dirname(dir);
  }
  return null;
}

export function findTsRoot(file: string): string | null {
  return findRoot(file, TS_MARKERS);
}

export function findPyRoot(file: string): string | null {
  return findRoot(file, PY_MARKERS);
}

const TS_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
]);
const PY_EXTS = new Set([".py", ".pyi"]);

export type Language = "typescript" | "python";

export function detectLanguage(file: string): Language | null {
  const ext = parse(file).ext;
  if (TS_EXTS.has(ext)) return "typescript";
  if (PY_EXTS.has(ext)) return "python";
  return null;
}

export function findRootForLanguage(
  file: string,
  lang: Language
): string | null {
  return lang === "typescript" ? findTsRoot(file) : findPyRoot(file);
}
