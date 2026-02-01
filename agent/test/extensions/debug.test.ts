import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createMockExtensionAPI,
  executeTool,
  getTextOutput,
  type MockExtensionAPI,
} from "../helpers.ts";
import initDebug from "../../extensions/debug.ts";

describe("debug extension", () => {
  let api: MockExtensionAPI;
  let tempDir: string;

  beforeEach(() => {
    api = createMockExtensionAPI();
    tempDir = join(tmpdir(), `pi-debug-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    initDebug(api);
  });

  afterEach(async () => {
    const stopTool = api._tools.get("debug_stop");
    if (stopTool) {
      try {
        await stopTool.execute("cleanup", {}, undefined, { cwd: tempDir } as any);
      } catch {}
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("debug_start", () => {
    it("starts the debug server and returns URL", async () => {
      const result = await executeTool(api, "debug_start", {}, { cwd: tempDir });
      const text = getTextOutput(result);
      expect(text).toContain("Debug Mode Started");
      expect(text).toContain("http://localhost:");
      expect((result.details as any).active).toBe(true);
      expect((result.details as any).port).toBeTypeOf("number");
    });

    it("starts on a custom port", async () => {
      const result = await executeTool(api, "debug_start", { port: 19876 }, { cwd: tempDir });
      expect((result.details as any).port).toBe(19876);
      expect((result.details as any).url).toContain("19876");
    });

    it("returns existing server if already running", async () => {
      await executeTool(api, "debug_start", {}, { cwd: tempDir });
      const second = await executeTool(api, "debug_start", {}, { cwd: tempDir });
      expect(getTextOutput(second)).toContain("already running");
      expect((second.details as any).active).toBe(true);
    });

    it("creates the .pi directory for logs", async () => {
      await executeTool(api, "debug_start", {}, { cwd: tempDir });
      expect(existsSync(join(tempDir, ".pi"))).toBe(true);
    });
  });

  describe("debug_stop", () => {
    it("stops a running server", async () => {
      await executeTool(api, "debug_start", {}, { cwd: tempDir });
      const result = await executeTool(api, "debug_stop", {}, { cwd: tempDir });
      expect(getTextOutput(result)).toContain("Debug Mode Stopped");
      expect((result.details as any).wasRunning).toBe(true);
    });

    it("reports when no server is running", async () => {
      const result = await executeTool(api, "debug_stop", {}, { cwd: tempDir });
      expect(getTextOutput(result)).toContain("not running");
      expect((result.details as any).wasRunning).toBe(false);
    });
  });

  describe("debug_read", () => {
    it("returns message when no log file exists", async () => {
      const result = await executeTool(api, "debug_read", {}, { cwd: tempDir });
      expect(getTextOutput(result)).toContain("No debug log");
    });

    it("returns message when log is empty", async () => {
      mkdirSync(join(tempDir, ".pi"), { recursive: true });
      writeFileSync(join(tempDir, ".pi", "debug.log"), "");
      const result = await executeTool(api, "debug_read", {}, { cwd: tempDir });
      expect(getTextOutput(result)).toContain("empty");
    });

    it("reads log entries", async () => {
      mkdirSync(join(tempDir, ".pi"), { recursive: true });
      writeFileSync(
        join(tempDir, ".pi", "debug.log"),
        '[2025-01-01T00:00:00.000Z] test-label | {"key":"value"}\n',
      );
      const result = await executeTool(api, "debug_read", {}, { cwd: tempDir });
      const text = getTextOutput(result);
      expect(text).toContain("test-label");
      expect(text).toContain("value");
      expect((result.details as any).entries).toBe(1);
    });

    it("supports tail parameter", async () => {
      mkdirSync(join(tempDir, ".pi"), { recursive: true });
      const lines = Array.from({ length: 10 }, (_, i) => `[2025-01-01T00:00:0${i}.000Z] entry-${i}`);
      writeFileSync(join(tempDir, ".pi", "debug.log"), lines.join("\n") + "\n");
      const result = await executeTool(api, "debug_read", { tail: 3 }, { cwd: tempDir });
      expect((result.details as any).entries).toBe(3);
      expect((result.details as any).total).toBe(10);
    });
  });

  describe("debug_clear", () => {
    it("clears existing log file", async () => {
      mkdirSync(join(tempDir, ".pi"), { recursive: true });
      const logPath = join(tempDir, ".pi", "debug.log");
      writeFileSync(logPath, "some data\n");
      const result = await executeTool(api, "debug_clear", {}, { cwd: tempDir });
      expect(getTextOutput(result)).toContain("cleared");
      expect((result.details as any).cleared).toBe(true);
      expect(readFileSync(logPath, "utf-8")).toBe("");
    });

    it("reports when no log exists", async () => {
      const result = await executeTool(api, "debug_clear", {}, { cwd: tempDir });
      expect((result.details as any).cleared).toBe(false);
    });
  });

  describe("debug_status", () => {
    it("reports inactive when not started", async () => {
      const result = await executeTool(api, "debug_status", {}, { cwd: tempDir });
      expect(getTextOutput(result)).toContain("not active");
      expect((result.details as any).active).toBe(false);
    });

    it("reports active with URL when started", async () => {
      await executeTool(api, "debug_start", {}, { cwd: tempDir });
      const result = await executeTool(api, "debug_status", {}, { cwd: tempDir });
      expect((result.details as any).active).toBe(true);
      expect((result.details as any).url).toContain("http://localhost:");
    });
  });

  describe("HTTP server functionality", () => {
    it("accepts debug POST requests and logs them", async () => {
      const startResult = await executeTool(api, "debug_start", {}, { cwd: tempDir });
      const url = (startResult.details as any).url as string;

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "test-entry", data: { foo: "bar" } }),
      });
      expect(response.ok).toBe(true);
      const body = await response.json();
      expect(body.received).toBe(true);

      const logContent = readFileSync(join(tempDir, ".pi", "debug.log"), "utf-8");
      expect(logContent).toContain("test-entry");
      expect(logContent).toContain("bar");
    });

    it("rejects POST without label", async () => {
      const startResult = await executeTool(api, "debug_start", {}, { cwd: tempDir });
      const url = (startResult.details as any).url as string;

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: { foo: "bar" } }),
      });
      expect(response.status).toBe(400);
    });

    it("rejects invalid JSON", async () => {
      const startResult = await executeTool(api, "debug_start", {}, { cwd: tempDir });
      const url = (startResult.details as any).url as string;

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      expect(response.status).toBe(400);
    });

    it("handles CORS preflight", async () => {
      const startResult = await executeTool(api, "debug_start", {}, { cwd: tempDir });
      const url = (startResult.details as any).url as string;

      const response = await fetch(url, { method: "OPTIONS" });
      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
    });

    it("health endpoint works", async () => {
      const startResult = await executeTool(api, "debug_start", {}, { cwd: tempDir });
      const port = (startResult.details as any).port as number;

      const response = await fetch(`http://localhost:${port}/health`);
      expect(response.ok).toBe(true);
      const body = await response.json();
      expect(body.status).toBe("ok");
    });

    it("returns 404 for unknown paths", async () => {
      const startResult = await executeTool(api, "debug_start", {}, { cwd: tempDir });
      const port = (startResult.details as any).port as number;

      const response = await fetch(`http://localhost:${port}/unknown`);
      expect(response.status).toBe(404);
    });

    it("logs entry without data field", async () => {
      const startResult = await executeTool(api, "debug_start", {}, { cwd: tempDir });
      const url = (startResult.details as any).url as string;

      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "no-data-label" }),
      });

      const logContent = readFileSync(join(tempDir, ".pi", "debug.log"), "utf-8");
      expect(logContent).toContain("no-data-label");
    });
  });

  describe("before_agent_start hook", () => {
    it("injects debug instructions when active", async () => {
      await executeTool(api, "debug_start", {}, { cwd: tempDir });
      const handlers = api._handlers.get("before_agent_start") ?? [];
      let systemPrompt: string | undefined;
      for (const handler of handlers) {
        const result = await handler({} as any, {} as any);
        if (result && typeof result === "object" && "systemPrompt" in (result as any)) {
          systemPrompt = (result as any).systemPrompt;
        }
      }
      expect(systemPrompt).toContain("Debug Mode Active");
      expect(systemPrompt).toContain("fetch(");
    });

    it("does not inject when inactive", async () => {
      const handlers = api._handlers.get("before_agent_start") ?? [];
      for (const handler of handlers) {
        const result = await handler({} as any, {} as any);
        expect(result).toBeUndefined();
      }
    });
  });
});
