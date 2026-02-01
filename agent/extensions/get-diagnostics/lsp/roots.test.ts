import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectLanguage, findRootForLanguage, findTsRoot, findPyRoot } from "./roots.ts";

describe("LSP roots", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `pi-roots-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("detectLanguage", () => {
    it("detects TypeScript", () => {
      expect(detectLanguage("/src/app.ts")).toBe("typescript");
      expect(detectLanguage("/src/app.tsx")).toBe("typescript");
      expect(detectLanguage("/src/app.mts")).toBe("typescript");
      expect(detectLanguage("/src/app.cts")).toBe("typescript");
    });

    it("detects JavaScript as typescript", () => {
      expect(detectLanguage("/src/app.js")).toBe("typescript");
      expect(detectLanguage("/src/app.jsx")).toBe("typescript");
      expect(detectLanguage("/src/app.mjs")).toBe("typescript");
      expect(detectLanguage("/src/app.cjs")).toBe("typescript");
    });

    it("detects Python", () => {
      expect(detectLanguage("/src/app.py")).toBe("python");
      expect(detectLanguage("/src/types.pyi")).toBe("python");
    });

    it("returns null for unsupported extensions", () => {
      expect(detectLanguage("/src/style.css")).toBeNull();
      expect(detectLanguage("/README.md")).toBeNull();
      expect(detectLanguage("/Makefile")).toBeNull();
      expect(detectLanguage("/src/app.rs")).toBeNull();
      expect(detectLanguage("/src/app.go")).toBeNull();
    });
  });

  describe("findTsRoot", () => {
    it("finds root with tsconfig.json", () => {
      const nested = join(tempDir, "src", "deep");
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(tempDir, "tsconfig.json"), "{}");
      const file = join(nested, "app.ts");
      expect(findTsRoot(file)).toBe(tempDir);
    });

    it("finds root with package.json", () => {
      const nested = join(tempDir, "src");
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(tempDir, "package.json"), "{}");
      const file = join(nested, "index.ts");
      expect(findTsRoot(file)).toBe(tempDir);
    });

    it("finds root with pnpm-lock.yaml", () => {
      const nested = join(tempDir, "lib");
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(tempDir, "pnpm-lock.yaml"), "");
      expect(findTsRoot(join(nested, "file.ts"))).toBe(tempDir);
    });

    it("returns null when no markers found", () => {
      const isolated = join(tempDir, "no-markers", "sub");
      mkdirSync(isolated, { recursive: true });
      expect(findTsRoot(join(isolated, "file.ts"))).toBeNull();
    });

    it("finds nearest root (not parent)", () => {
      const parent = tempDir;
      const child = join(parent, "packages", "core");
      mkdirSync(child, { recursive: true });
      writeFileSync(join(parent, "package.json"), "{}");
      writeFileSync(join(child, "tsconfig.json"), "{}");
      expect(findTsRoot(join(child, "index.ts"))).toBe(child);
    });
  });

  describe("findPyRoot", () => {
    it("finds root with pyproject.toml", () => {
      const nested = join(tempDir, "src");
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(tempDir, "pyproject.toml"), "");
      expect(findPyRoot(join(nested, "main.py"))).toBe(tempDir);
    });

    it("finds root with requirements.txt", () => {
      const nested = join(tempDir, "app");
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(tempDir, "requirements.txt"), "");
      expect(findPyRoot(join(nested, "app.py"))).toBe(tempDir);
    });

    it("finds root with setup.py", () => {
      writeFileSync(join(tempDir, "setup.py"), "");
      expect(findPyRoot(join(tempDir, "module.py"))).toBe(tempDir);
    });

    it("returns null when no Python markers", () => {
      const isolated = join(tempDir, "no-py");
      mkdirSync(isolated, { recursive: true });
      expect(findPyRoot(join(isolated, "file.py"))).toBeNull();
    });
  });

  describe("findRootForLanguage", () => {
    it("delegates to findTsRoot for typescript", () => {
      writeFileSync(join(tempDir, "package.json"), "{}");
      expect(findRootForLanguage(join(tempDir, "app.ts"), "typescript")).toBe(tempDir);
    });

    it("delegates to findPyRoot for python", () => {
      writeFileSync(join(tempDir, "pyproject.toml"), "");
      expect(findRootForLanguage(join(tempDir, "app.py"), "python")).toBe(tempDir);
    });
  });
});
