import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Tests for codebase extension helper logic.
 *
 * Since the functions are module-private, we replicate the pure
 * functions here to test the algorithms. The extension itself is
 * tested through integration (git operations require network).
 */

function computeCacheKey(
  repoUrl: string,
  branch: string,
  sparsePaths?: string[]
): string {
  const normalized = repoUrl.replace(/\.git$/, "").toLowerCase();
  const sparse = sparsePaths ? [...sparsePaths].sort().join("|") : "";
  const raw = `${normalized}::${branch}::${sparse}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
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

function classifyGitError(stderr: string): {
  kind: GitErrorKind;
  hint: string;
} {
  for (const [kind, patterns] of ERROR_PATTERNS) {
    if (patterns.some((p) => p.test(stderr))) {
      return { kind, hint: "" };
    }
  }
  return { kind: "unknown", hint: "" };
}

describe("codebase extension logic", () => {
  describe("computeCacheKey", () => {
    it("produces a 16-char hex string", () => {
      const key = computeCacheKey("https://github.com/user/repo", "main");
      expect(key).toMatch(/^[0-9a-f]{16}$/);
    });

    it("normalizes .git suffix", () => {
      const k1 = computeCacheKey("https://github.com/user/repo.git", "main");
      const k2 = computeCacheKey("https://github.com/user/repo", "main");
      expect(k1).toBe(k2);
    });

    it("normalizes case", () => {
      const k1 = computeCacheKey("https://GitHub.com/User/Repo", "main");
      const k2 = computeCacheKey("https://github.com/user/repo", "main");
      expect(k1).toBe(k2);
    });

    it("different branches produce different keys", () => {
      const k1 = computeCacheKey("https://github.com/user/repo", "main");
      const k2 = computeCacheKey("https://github.com/user/repo", "develop");
      expect(k1).not.toBe(k2);
    });

    it("different repos produce different keys", () => {
      const k1 = computeCacheKey("https://github.com/user/repo-a", "main");
      const k2 = computeCacheKey("https://github.com/user/repo-b", "main");
      expect(k1).not.toBe(k2);
    });

    it("sparse paths affect the key", () => {
      const k1 = computeCacheKey("https://github.com/user/repo", "main");
      const k2 = computeCacheKey("https://github.com/user/repo", "main", [
        "src",
      ]);
      expect(k1).not.toBe(k2);
    });

    it("sparse paths are sorted for consistency", () => {
      const k1 = computeCacheKey("https://github.com/user/repo", "main", [
        "src",
        "docs",
      ]);
      const k2 = computeCacheKey("https://github.com/user/repo", "main", [
        "docs",
        "src",
      ]);
      expect(k1).toBe(k2);
    });

    it("empty sparse paths equals no sparse paths", () => {
      const k1 = computeCacheKey("https://github.com/user/repo", "main");
      const k2 = computeCacheKey("https://github.com/user/repo", "main", []);
      expect(k1).toBe(k2);
    });
  });

  describe("classifyGitError", () => {
    it("classifies branch not found", () => {
      expect(
        classifyGitError("fatal: couldn't find remote ref feature-x").kind
      ).toBe("branch_not_found");
      expect(
        classifyGitError("Remote branch foo not found in upstream").kind
      ).toBe("branch_not_found");
    });

    it("classifies repo not found", () => {
      expect(classifyGitError("remote: Repository not found.").kind).toBe(
        "repo_not_found"
      );
      expect(
        classifyGitError("fatal: repository 'https://...' not found").kind
      ).toBe("repo_not_found");
    });

    it("classifies auth failures", () => {
      expect(
        classifyGitError("fatal: Authentication failed for 'https://...'").kind
      ).toBe("auth_failed");
      expect(
        classifyGitError("fatal: could not read Username for 'https://...'")
          .kind
      ).toBe("auth_failed");
      expect(classifyGitError("Permission denied (publickey)").kind).toBe(
        "auth_failed"
      );
      expect(
        classifyGitError("The requested URL returned error: 403").kind
      ).toBe("auth_failed");
    });

    it("classifies rate limiting", () => {
      expect(classifyGitError("rate limit exceeded").kind).toBe("rate_limited");
      expect(classifyGitError("HTTP 429 Too Many Requests").kind).toBe(
        "rate_limited"
      );
    });

    it("classifies network errors", () => {
      expect(classifyGitError("Could not resolve host: github.com").kind).toBe(
        "network_error"
      );
      expect(classifyGitError("Connection refused").kind).toBe("network_error");
      expect(classifyGitError("Connection timed out").kind).toBe(
        "network_error"
      );
      expect(classifyGitError("SSL certificate problem").kind).toBe(
        "network_error"
      );
    });

    it("returns unknown for unrecognized errors", () => {
      expect(classifyGitError("something unexpected happened").kind).toBe(
        "unknown"
      );
      expect(classifyGitError("").kind).toBe("unknown");
    });
  });

  describe("README detection (integration-style)", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = join(tmpdir(), `pi-codebase-test-${Date.now()}`);
      mkdirSync(tempDir, { recursive: true });
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    const README_CANDIDATES = [
      "README.md",
      "readme.md",
      "README",
      "README.rst",
      "README.txt",
    ];

    it("finds README.md first", () => {
      writeFileSync(join(tempDir, "README.md"), "# Hello");
      writeFileSync(join(tempDir, "README.rst"), "Hello");
      const found = README_CANDIDATES.find((name) => {
        try {
          return require("fs").existsSync(join(tempDir, name));
        } catch {
          return false;
        }
      });
      expect(found).toBe("README.md");
    });

    it("falls back to README.rst when no .md", () => {
      writeFileSync(join(tempDir, "README.rst"), "Hello");
      const found = README_CANDIDATES.find((name) => {
        try {
          return require("fs").existsSync(join(tempDir, name));
        } catch {
          return false;
        }
      });
      expect(found).toBe("README.rst");
    });
  });
});
