/**
 * Codebase Extension
 *
 * Clones GitHub repos into disposable local directories and symlinks
 * them into .pi/codebases/ so the agent's built-in tools (read, grep,
 * find) can access the source code directly.
 *
 * Features:
 * - Auto-detects default branch (no more assuming "main")
 * - Optional sparse checkout for large repos (path param)
 * - Returns initial context (dir listing + README) on create
 * - Non-interactive git (never hangs for credentials)
 * - Symlink cleanup guaranteed on session end + stale sweep on startup
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { execSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CLONE_ROOT = join(homedir(), "Library", "Caches", "pi", "codebases");
const MARKER_FILE = ".codebase.json";
const STALE_TTL_MS = 24 * 60 * 60 * 1000;
const README_PREVIEW_LINES = 40;

const GIT_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "Never",
};

interface CloneInfo {
  id: string;
  clonePath: string;
  symlinkPath: string;
  repo: string;
  branch: string;
  sparsePaths?: string[];
  createdAt: number;
}

type GitErrorKind =
  | "branch_not_found"
  | "repo_not_found"
  | "auth_failed"
  | "rate_limited"
  | "network_error"
  | "unknown";

const ERROR_PATTERNS: [GitErrorKind, RegExp[]][] = [
  [
    "branch_not_found",
    [
      /couldn't find remote ref/i,
      /Remote branch .* not found/i,
      /fatal: invalid refspec/i,
    ],
  ],
  [
    "repo_not_found",
    [
      /Repository not found/i,
      /remote: Repository not found/i,
      /fatal: repository .* not found/i,
    ],
  ],
  [
    "auth_failed",
    [
      /Authentication failed/i,
      /could not read Username/i,
      /Permission denied/i,
      /403/,
    ],
  ],
  ["rate_limited", [/rate limit/i, /too many requests/i, /429/]],
  [
    "network_error",
    [
      /Could not resolve host/i,
      /Connection refused/i,
      /Connection timed out/i,
      /SSL/i,
    ],
  ],
];

const ERROR_HINTS: Record<GitErrorKind, string> = {
  branch_not_found:
    "Try omitting branch to auto-detect default, or specify an existing branch.",
  repo_not_found: "Check the owner/repo spelling or URL.",
  auth_failed: "Private repo? Ensure git credentials or gh auth is configured.",
  rate_limited: "Wait a few minutes or authenticate to raise rate limits.",
  network_error: "Check network connection or VPN.",
  unknown: "Check the repo URL and try again.",
};

function classifyGitError(stderr: string): {
  kind: GitErrorKind;
  hint: string;
} {
  for (const [kind, patterns] of ERROR_PATTERNS) {
    if (patterns.some((p) => p.test(stderr))) {
      return { kind, hint: ERROR_HINTS[kind] };
    }
  }
  return { kind: "unknown", hint: ERROR_HINTS.unknown };
}

function generateId(): string {
  return `cb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function git(args: string, cwd?: string): string {
  return execSync(`git ${args}`, {
    cwd,
    encoding: "utf-8",
    timeout: 120_000,
    env: { ...process.env, ...GIT_ENV },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function resolveDefaultBranch(repoUrl: string): string {
  try {
    const output = git(`ls-remote --symref "${repoUrl}" HEAD`);
    const match = output.match(/ref: refs\/heads\/(\S+)\s+HEAD/);
    if (match?.[1]) return match[1];
  } catch {}

  try {
    const output = git(`ls-remote --heads "${repoUrl}" main master`);
    if (output.includes("refs/heads/main")) return "main";
    if (output.includes("refs/heads/master")) return "master";
  } catch {}

  return "main";
}

function cloneRepo(
  repoUrl: string,
  branch: string,
  sparsePaths: string[] | undefined,
  symlinkDir: string
): CloneInfo {
  const id = generateId();
  const clonePath = join(CLONE_ROOT, id);
  mkdirSync(clonePath, { recursive: true });

  if (sparsePaths && sparsePaths.length > 0) {
    git(
      `clone --depth 1 --filter=blob:none --no-checkout --sparse --single-branch --branch "${branch}" "${repoUrl}" "${clonePath}"`
    );
    git(
      `sparse-checkout set ${sparsePaths.map((p) => `"${p}"`).join(" ")}`,
      clonePath
    );
    git("checkout", clonePath);
  } else {
    git(
      `clone --depth 1 --single-branch --branch "${branch}" "${repoUrl}" "${clonePath}"`
    );
  }

  mkdirSync(symlinkDir, { recursive: true });
  const symlinkPath = join(symlinkDir, id);
  symlinkSync(clonePath, symlinkPath);

  const info: CloneInfo = {
    id,
    clonePath,
    symlinkPath,
    repo: repoUrl,
    branch,
    sparsePaths,
    createdAt: Date.now(),
  };
  writeMarker(info);
  return info;
}

function writeMarker(info: CloneInfo) {
  writeFileSync(
    join(info.clonePath, MARKER_FILE),
    JSON.stringify(info, null, 2)
  );
}

function readMarker(dir: string): CloneInfo | null {
  const p = join(dir, MARKER_FILE);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

function destroyClone(info: CloneInfo) {
  try {
    if (existsSync(info.symlinkPath)) unlinkSync(info.symlinkPath);
  } catch {}
  rmSync(info.clonePath, { recursive: true, force: true });
}

function getInitialContext(clonePath: string, sparsePaths?: string[]): string {
  const lines: string[] = [];

  try {
    const entries = readdirSync(clonePath)
      .filter((e) => !e.startsWith("."))
      .sort();
    const dirs: string[] = [];
    const files: string[] = [];
    for (const entry of entries) {
      try {
        const s = statSync(join(clonePath, entry));
        if (s.isDirectory()) dirs.push(entry + "/");
        else files.push(entry);
      } catch {}
    }
    lines.push("Contents: " + [...dirs, ...files].join(", "));
  } catch {}

  if (sparsePaths && sparsePaths.length > 0) {
    lines.push("Sparse checkout: only " + sparsePaths.join(", ") + " fetched");
  }

  const readmeCandidates = [
    "README.md",
    "readme.md",
    "README",
    "README.rst",
    "README.txt",
  ];
  for (const name of readmeCandidates) {
    const p = join(clonePath, name);
    if (existsSync(p)) {
      try {
        const content = readFileSync(p, "utf-8");
        const preview = content
          .split("\n")
          .slice(0, README_PREVIEW_LINES)
          .join("\n");
        lines.push(
          `\n--- ${name} (first ${README_PREVIEW_LINES} lines) ---\n${preview}`
        );
      } catch {}
      break;
    }
  }

  return lines.join("\n");
}

function sweepStaleClones() {
  if (!existsSync(CLONE_ROOT)) return;

  const now = Date.now();
  for (const entry of readdirSync(CLONE_ROOT)) {
    const dir = join(CLONE_ROOT, entry);
    try {
      const stat = statSync(dir);
      if (!stat.isDirectory()) continue;

      const marker = readMarker(dir);
      if (marker && now - marker.createdAt > STALE_TTL_MS) {
        destroyClone(marker);
      } else if (!marker && now - stat.mtimeMs > STALE_TTL_MS) {
        rmSync(dir, { recursive: true, force: true });
      }
    } catch {}
  }
}

function sweepDanglingSymlinks(symlinkDir: string) {
  if (!existsSync(symlinkDir)) return;

  for (const entry of readdirSync(symlinkDir)) {
    const p = join(symlinkDir, entry);
    try {
      const lst = lstatSync(p);
      if (!lst.isSymbolicLink()) continue;
      const target = readlinkSync(p);
      if (!existsSync(target)) {
        unlinkSync(p);
      }
    } catch {}
  }

  try {
    const remaining = readdirSync(symlinkDir);
    if (remaining.length === 0) rmSync(symlinkDir, { force: true });
  } catch {}
}

export default function (pi: ExtensionAPI) {
  const activeClones = new Map<string, CloneInfo>();
  let sessionCwd = process.cwd();

  function symlinkDir(): string {
    return join(sessionCwd, ".pi", "codebases");
  }

  function getOnlyActive(): CloneInfo | undefined {
    if (activeClones.size === 1) {
      return activeClones.values().next().value;
    }
    return undefined;
  }

  pi.registerTool({
    name: "codebase",
    label: "Codebase",
    description:
      "Clone a GitHub repo into a disposable local directory for reading source code. " +
      "Creates a symlink at .pi/codebases/<id> so you can use read, grep, and find directly on it. " +
      "Actions: create (shallow clone a repo), destroy (remove a clone), list (show active clones).",
    parameters: Type.Object({
      action: StringEnum(["create", "destroy", "list"] as const),
      repo: Type.Optional(
        Type.String({
          description:
            "GitHub repo URL or owner/repo shorthand (for create action)",
        })
      ),
      branch: Type.Optional(
        Type.String({ description: "Branch to clone (default: auto-detect)" })
      ),
      path: Type.Optional(
        Type.String({
          description:
            "Subdirectory to sparse-checkout (e.g. 'docs' or 'src/lib'). " +
            "Use for large repos to only fetch specific paths. " +
            "Comma-separated for multiple paths.",
        })
      ),
      id: Type.Optional(
        Type.String({
          description:
            "Clone ID (required for destroy when multiple clones exist)",
        })
      ),
    }),

    async execute(toolCallId, params, onUpdate, _ctx, _signal) {
      const {
        action,
        repo,
        branch,
        path: sparsePath,
        id,
      } = params as {
        action: string;
        repo?: string;
        branch?: string;
        path?: string;
        id?: string;
      };

      switch (action) {
        case "create": {
          if (!repo) {
            throw new Error(
              "Missing 'repo' parameter. Provide a GitHub URL or owner/repo shorthand."
            );
          }

          const repoUrl = repo.startsWith("http")
            ? repo
            : `https://github.com/${repo}`;

          const sparsePaths = sparsePath
            ? sparsePath
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
            : undefined;

          onUpdate?.({
            content: [
              {
                type: "text" as const,
                text: branch
                  ? `Cloning ${repoUrl} (${branch})...`
                  : `Detecting default branch for ${repoUrl}...`,
              },
            ],
            details: {},
          });

          let resolvedBranch: string;
          try {
            resolvedBranch = branch || resolveDefaultBranch(repoUrl);
          } catch (e: unknown) {
            const err = e as { stderr?: string; message?: string };
            const stderr = err.stderr || err.message || "";
            const { kind, hint } = classifyGitError(stderr);
            throw new Error(
              `Failed to detect default branch (${kind}): ${hint}\nRaw: ${stderr.slice(0, 200)}`
            );
          }

          if (!branch) {
            onUpdate?.({
              content: [
                {
                  type: "text" as const,
                  text: `Cloning ${repoUrl} (${resolvedBranch})...`,
                },
              ],
              details: {},
            });
          }

          try {
            const info = cloneRepo(
              repoUrl,
              resolvedBranch,
              sparsePaths,
              symlinkDir()
            );
            activeClones.set(info.id, info);

            const context = getInitialContext(info.clonePath, sparsePaths);
            const relativePath = `.pi/codebases/${info.id}`;

            return {
              content: [
                {
                  type: "text" as const,
                  text: [
                    `Cloned: ${info.id}`,
                    `Repo: ${repoUrl}`,
                    `Branch: ${resolvedBranch}`,
                    `Path: ${relativePath}`,
                    "",
                    context,
                    "",
                    `Use read, grep, find on "${relativePath}" to explore the source.`,
                  ].join("\n"),
                },
              ],
              details: {
                id: info.id,
                path: relativePath,
                absolutePath: info.clonePath,
                repo: repoUrl,
                branch: resolvedBranch,
                sparsePaths,
              },
            };
          } catch (e: unknown) {
            const err = e as { stderr?: string; message?: string };
            const stderr = err.stderr || err.message || "";
            const { kind, hint } = classifyGitError(stderr);
            throw new Error(
              `Clone failed (${kind}): ${hint}\nRaw: ${stderr.slice(0, 300)}`
            );
          }
        }

        case "destroy": {
          const clone = id ? activeClones.get(id) : getOnlyActive();
          if (!clone) {
            const msg = id
              ? `Clone '${id}' not found.`
              : activeClones.size === 0
                ? "No active clones."
                : "Multiple clones active. Specify an id.";
            throw new Error(msg);
          }

          try {
            destroyClone(clone);
            activeClones.delete(clone.id);
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Destroyed clone '${clone.id}'.`,
                },
              ],
              details: {},
            };
          } catch (e) {
            throw new Error(
              `Failed to destroy: ${e instanceof Error ? e.message : String(e)}`
            );
          }
        }

        case "list": {
          if (activeClones.size === 0) {
            return {
              content: [{ type: "text" as const, text: "No active clones." }],
              details: {},
            };
          }

          const lines = Array.from(activeClones.values()).map(
            (c) => `${c.id}  ${c.repo}  (${c.branch})  .pi/codebases/${c.id}`
          );
          return {
            content: [{ type: "text" as const, text: lines.join("\n") }],
            details: { count: activeClones.size },
          };
        }

        default:
          throw new Error(
            `Unknown action '${action}'. Use: create, destroy, list.`
          );
      }
    },

    renderCall(args, theme) {
      const { action, repo, id } = args as {
        action?: string;
        repo?: string;
        id?: string;
      };
      let label = `codebase ${action || "?"}`;
      if (repo) label += ` ${repo}`;
      if (id) label += ` ${id}`;
      return new Text(theme.fg("toolTitle", label), 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const text =
        result.content?.[0]?.type === "text"
          ? (result.content[0] as { text: string }).text
          : "";
      if (!expanded) {
        const first = text.split("\n")[0] || "";
        return new Text(theme.fg("muted", first), 0, 0);
      }
      return new Text(theme.fg("toolOutput", text), 0, 0);
    },
  });

  pi.registerCommand("codebases", {
    description: "List active repo clones",
    handler: async (_args, ctx) => {
      if (activeClones.size === 0) {
        ctx.ui.notify("No active clones", "info");
        return;
      }
      const lines = Array.from(activeClones.values()).map(
        (c) => `  ${c.id}  ${c.repo}  (${c.branch})`
      );
      ctx.ui.notify(`Active clones:\n${lines.join("\n")}`, "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    sessionCwd = ctx.cwd;
    mkdirSync(CLONE_ROOT, { recursive: true });
    sweepStaleClones();
    sweepDanglingSymlinks(symlinkDir());
  });

  pi.on("session_shutdown", async () => {
    for (const [, info] of activeClones) {
      try {
        destroyClone(info);
      } catch {}
    }
    activeClones.clear();
    sweepDanglingSymlinks(symlinkDir());
  });
}
