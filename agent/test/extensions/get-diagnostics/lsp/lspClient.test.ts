import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDiagnosticsForFile } from "../../../../extensions/get-diagnostics/lsp/lspClient.ts";
import type { LspServer } from "../../../../extensions/get-diagnostics/lsp/servers.ts";
import { createConnection } from "../../../../extensions/get-diagnostics/lsp/jsonrpc.ts";

function createMockProcess() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  return {
    stdin,
    stdout,
    stderr: new PassThrough(),
    kill: vi.fn(),
    killed: false,
    pid: 12345,
    on: vi.fn(),
  };
}

function sendLspMessage(stdout: PassThrough, msg: unknown) {
  const json = JSON.stringify(msg);
  const len = Buffer.byteLength(json, "utf8");
  stdout.write(`Content-Length: ${len}\r\n\r\n${json}`);
}

function createMockServer(
  proc: ReturnType<typeof createMockProcess>,
  opts: { pullDiagnostics: boolean }
): LspServer {
  const conn = createConnection(proc as any);
  const diagnostics = new Map();
  const waiters = new Map();

  conn.onNotification = (method, params) => {
    if (method === "textDocument/publishDiagnostics") {
      const p = params as { uri: string; diagnostics: any[] };
      const filePath = p.uri.startsWith("file://")
        ? decodeURIComponent(new URL(p.uri).pathname)
        : p.uri;
      diagnostics.set(filePath, p.diagnostics);
      const fns = waiters.get(filePath);
      if (fns) {
        for (const fn of fns) fn();
        waiters.delete(filePath);
      }
    }
  };

  return {
    id: opts.pullDiagnostics ? "ty" : "tsserver",
    language: opts.pullDiagnostics ? "python" : "typescript",
    root: "/tmp",
    proc: proc as any,
    conn,
    diagnostics,
    waiters,
    ready: Promise.resolve(),
    pullDiagnostics: opts.pullDiagnostics,
  };
}

describe("getDiagnosticsForFile", () => {
  let tempDir: string;
  let testFile: string;

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `pi-lsp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(tempDir, { recursive: true });
    testFile = join(tempDir, "test.py");
    writeFileSync(testFile, 'x: int = "hello"\n');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("push diagnostics (publishDiagnostics)", () => {
    it("returns diagnostics from publishDiagnostics notification", async () => {
      const proc = createMockProcess();
      const server = createMockServer(proc, { pullDiagnostics: false });

      const sentMessages: string[] = [];
      proc.stdin.on("data", (chunk: Buffer) =>
        sentMessages.push(chunk.toString("utf8"))
      );

      const promise = getDiagnosticsForFile(server, testFile);

      await new Promise((r) => setTimeout(r, 10));

      const uri = pathToFileURL(testFile).toString();
      sendLspMessage(proc.stdout, {
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: {
          uri,
          diagnostics: [
            {
              range: {
                start: { line: 0, character: 9 },
                end: { line: 0, character: 16 },
              },
              severity: 1,
              code: "invalid-assignment",
              source: "tsserver",
              message: 'Type "string" is not assignable to type "int"',
            },
          ],
        },
      });

      const result = await promise;
      expect(result).toHaveLength(1);
      expect(result[0].code).toBe("invalid-assignment");
      expect(result[0].severity).toBe(1);

      const allSent = sentMessages.join("");
      expect(allSent).toContain("textDocument/didOpen");
      expect(allSent).toContain("textDocument/didClose");

      server.conn.dispose();
    });

    it("returns empty array on timeout with no diagnostics", async () => {
      const proc = createMockProcess();
      const server = createMockServer(proc, { pullDiagnostics: false });

      const result = await getDiagnosticsForFile(server, testFile);
      expect(result).toEqual([]);

      server.conn.dispose();
    }, 10000);
  });

  describe("pull diagnostics (textDocument/diagnostic)", () => {
    it("sends textDocument/diagnostic request and returns items", async () => {
      const proc = createMockProcess();
      const server = createMockServer(proc, { pullDiagnostics: true });

      const sentMessages: string[] = [];
      proc.stdin.on("data", (chunk: Buffer) =>
        sentMessages.push(chunk.toString("utf8"))
      );

      const promise = getDiagnosticsForFile(server, testFile);

      await new Promise((r) => setTimeout(r, 10));

      const allSent = sentMessages.join("");
      expect(allSent).toContain("textDocument/didOpen");
      expect(allSent).toContain("textDocument/diagnostic");

      const diagRequestMatch = allSent.match(/"id":(\d+).*?"textDocument\/diagnostic"/);
      expect(diagRequestMatch).not.toBeNull();
      const requestId = parseInt(diagRequestMatch![1], 10);

      sendLspMessage(proc.stdout, {
        jsonrpc: "2.0",
        id: requestId,
        result: {
          kind: "full",
          items: [
            {
              range: {
                start: { line: 0, character: 4 },
                end: { line: 0, character: 16 },
              },
              severity: 1,
              code: "invalid-assignment",
              source: "ty",
              message:
                'Object of type `Literal["hello"]` is not assignable to `int`',
            },
          ],
        },
      });

      const result = await promise;
      expect(result).toHaveLength(1);
      expect(result[0].code).toBe("invalid-assignment");
      expect(result[0].source).toBe("ty");
      expect(result[0].message).toContain("not assignable");

      server.conn.dispose();
    });

    it("returns empty array when pull result has no items", async () => {
      const proc = createMockProcess();
      const server = createMockServer(proc, { pullDiagnostics: true });

      const sentMessages: string[] = [];
      proc.stdin.on("data", (chunk: Buffer) =>
        sentMessages.push(chunk.toString("utf8"))
      );

      const promise = getDiagnosticsForFile(server, testFile);

      await new Promise((r) => setTimeout(r, 10));

      const allSent = sentMessages.join("");
      const diagRequestMatch = allSent.match(
        /"id":(\d+).*?"textDocument\/diagnostic"/
      );
      const requestId = parseInt(diagRequestMatch![1], 10);

      sendLspMessage(proc.stdout, {
        jsonrpc: "2.0",
        id: requestId,
        result: { kind: "full", items: [] },
      });

      const result = await promise;
      expect(result).toEqual([]);

      server.conn.dispose();
    });

    it("returns empty array when pull request fails", async () => {
      const proc = createMockProcess();
      const server = createMockServer(proc, { pullDiagnostics: true });

      const sentMessages: string[] = [];
      proc.stdin.on("data", (chunk: Buffer) =>
        sentMessages.push(chunk.toString("utf8"))
      );

      const promise = getDiagnosticsForFile(server, testFile);

      await new Promise((r) => setTimeout(r, 10));

      const allSent = sentMessages.join("");
      const diagRequestMatch = allSent.match(
        /"id":(\d+).*?"textDocument\/diagnostic"/
      );
      const requestId = parseInt(diagRequestMatch![1], 10);

      sendLspMessage(proc.stdout, {
        jsonrpc: "2.0",
        id: requestId,
        error: { code: -32601, message: "Method not supported" },
      });

      const result = await promise;
      expect(result).toEqual([]);

      server.conn.dispose();
    });

    it("returns empty array for non-existent file", async () => {
      const proc = createMockProcess();
      const server = createMockServer(proc, { pullDiagnostics: true });

      const result = await getDiagnosticsForFile(
        server,
        join(tempDir, "nonexistent.py")
      );
      expect(result).toEqual([]);

      server.conn.dispose();
    });

    it("does not wait for publishDiagnostics in pull mode", async () => {
      const proc = createMockProcess();
      const server = createMockServer(proc, { pullDiagnostics: true });

      const sentMessages: string[] = [];
      proc.stdin.on("data", (chunk: Buffer) =>
        sentMessages.push(chunk.toString("utf8"))
      );

      const promise = getDiagnosticsForFile(server, testFile);

      await new Promise((r) => setTimeout(r, 10));

      const allSent = sentMessages.join("");
      const diagRequestMatch = allSent.match(
        /"id":(\d+).*?"textDocument\/diagnostic"/
      );
      const requestId = parseInt(diagRequestMatch![1], 10);

      sendLspMessage(proc.stdout, {
        jsonrpc: "2.0",
        id: requestId,
        result: {
          kind: "full",
          items: [
            {
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 1 },
              },
              severity: 2,
              message: "pull diagnostic",
            },
          ],
        },
      });

      const result = await promise;
      expect(result).toHaveLength(1);
      expect(result[0].message).toBe("pull diagnostic");

      expect(server.waiters.size).toBe(0);

      server.conn.dispose();
    });
  });
});
