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

const GO_MARKERS = ["go.work", "go.mod", "go.sum"];

const ASTRO_MARKERS = [
  "astro.config.mjs",
  "astro.config.js",
  "astro.config.cjs",
  "astro.config.ts",
  "astro.config.mts",
  "astro.config.cts",
  ...TS_MARKERS,
];

const YAML_MARKERS = [".git", ...TS_MARKERS];
const MARKDOWN_MARKERS = [".git"];

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

export function findGoRoot(file: string): string | null {
  return findRoot(file, GO_MARKERS);
}

export function findAstroRoot(file: string): string | null {
  return findRoot(file, ASTRO_MARKERS) ?? findTsRoot(file);
}

export function findYamlRoot(file: string): string | null {
  return findRoot(file, YAML_MARKERS);
}

export function findMarkdownRoot(file: string): string | null {
  return findRoot(file, MARKDOWN_MARKERS);
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
const GO_EXTS = new Set([".go"]);
const YAML_EXTS = new Set([".yaml", ".yml"]);
const ASTRO_EXTS = new Set([".astro"]);
const MARKDOWN_EXTS = new Set([".md", ".mdx", ".markdown"]);

export type Language =
  | "typescript"
  | "python"
  | "go"
  | "yaml"
  | "astro"
  | "markdown";

export function detectLanguage(file: string): Language | null {
  const ext = parse(file).ext;
  if (TS_EXTS.has(ext)) return "typescript";
  if (PY_EXTS.has(ext)) return "python";
  if (GO_EXTS.has(ext)) return "go";
  if (YAML_EXTS.has(ext)) return "yaml";
  if (ASTRO_EXTS.has(ext)) return "astro";
  if (MARKDOWN_EXTS.has(ext)) return "markdown";
  return null;
}

export function findRootForLanguage(
  file: string,
  lang: Language
): string | null {
  switch (lang) {
    case "typescript":
      return findTsRoot(file);
    case "python":
      return findPyRoot(file);
    case "go":
      return findGoRoot(file);
    case "yaml":
      return findYamlRoot(file);
    case "astro":
      return findAstroRoot(file);
    case "markdown":
      return findMarkdownRoot(file);
    default:
      return null;
  }
}
