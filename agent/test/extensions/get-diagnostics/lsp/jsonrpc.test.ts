import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConnection, type JsonRpcConnection } from "../../../../extensions/get-diagnostics/lsp/jsonrpc.ts";

function createMockProcess() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const proc = {
    stdin,
    stdout,
    stderr: new PassThrough(),
    kill: vi.fn(),
    killed: false,
    pid: 12345,
    on: vi.fn(),
  };
  return proc;
}

function sendLspMessage(stdout: PassThrough, msg: unknown) {
  const json = JSON.stringify(msg);
  const len = Buffer.byteLength(json, "utf8");
  stdout.write(`Content-Length: ${len}\r\n\r\n${json}`);
}

describe("JSON-RPC connection", () => {
  let proc: ReturnType<typeof createMockProcess>;
  let conn: JsonRpcConnection;

  beforeEach(() => {
    proc = createMockProcess();
    conn = createConnection(proc as any);
  });

  afterEach(() => {
    conn.dispose();
  });

  describe("sendRequest", () => {
    it("sends a properly formatted LSP request", async () => {
      const chunks: Buffer[] = [];
      proc.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));

      const promise = conn.sendRequest("initialize", { processId: 1 });

      await new Promise((r) => setTimeout(r, 10));

      sendLspMessage(proc.stdout, {
        jsonrpc: "2.0",
        id: 1,
        result: { capabilities: {} },
      });

      const result = await promise;
      expect(result).toEqual({ capabilities: {} });

      const sent = Buffer.concat(chunks).toString("utf8");
      expect(sent).toContain("Content-Length:");
      expect(sent).toContain('"method":"initialize"');
      expect(sent).toContain('"id":1');
    });

    it("resolves when response arrives", async () => {
      const promise = conn.sendRequest("textDocument/hover", { uri: "file:///test.ts" });

      sendLspMessage(proc.stdout, {
        jsonrpc: "2.0",
        id: 1,
        result: { contents: "hello" },
      });

      const result = await promise;
      expect(result).toEqual({ contents: "hello" });
    });

    it("rejects on error response", async () => {
      const promise = conn.sendRequest("bad/method", {});

      sendLspMessage(proc.stdout, {
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32601, message: "Method not found" },
      });

      await expect(promise).rejects.toThrow("Method not found");
    });

    it("times out after specified duration", async () => {
      const promise = conn.sendRequest("slow/method", {}, 50);
      await expect(promise).rejects.toThrow("timed out");
    });

    it("increments request IDs", async () => {
      const chunks: Buffer[] = [];
      proc.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));

      void conn.sendRequest("method1", {});
      void conn.sendRequest("method2", {});

      await new Promise((r) => setTimeout(r, 10));

      const sent = Buffer.concat(chunks).toString("utf8");
      expect(sent).toContain('"id":1');
      expect(sent).toContain('"id":2');

      sendLspMessage(proc.stdout, { jsonrpc: "2.0", id: 1, result: null });
      sendLspMessage(proc.stdout, { jsonrpc: "2.0", id: 2, result: null });
    });
  });

  describe("sendNotification", () => {
    it("sends notification without id", () => {
      const chunks: Buffer[] = [];
      proc.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));

      conn.sendNotification("initialized", {});

      const sent = Buffer.concat(chunks).toString("utf8");
      expect(sent).toContain('"method":"initialized"');
      expect(sent).not.toContain('"id"');
    });
  });

  describe("onNotification", () => {
    it("receives server notifications", async () => {
      const notifications: Array<{ method: string; params: any }> = [];
      conn.onNotification = (method, params) => {
        notifications.push({ method, params });
      };

      sendLspMessage(proc.stdout, {
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: { uri: "file:///test.ts", diagnostics: [] },
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(notifications).toHaveLength(1);
      expect(notifications[0].method).toBe("textDocument/publishDiagnostics");
      expect(notifications[0].params.uri).toBe("file:///test.ts");
    });
  });

  describe("onRequest", () => {
    it("handles server-initiated requests and responds", async () => {
      conn.onRequest = async (method, _params) => {
        if (method === "workspace/configuration") {
          return [{ validate: "on" }];
        }
        return null;
      };

      sendLspMessage(proc.stdout, {
        jsonrpc: "2.0",
        id: 100,
        method: "workspace/configuration",
        params: { items: [{ section: "eslint" }] },
      });

      await new Promise((r) => setTimeout(r, 50));

      const chunks: Buffer[] = [];
      proc.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
      await new Promise((r) => setTimeout(r, 10));
    });

    it("responds with null when no request handler", async () => {
      const chunks: Buffer[] = [];
      proc.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));

      sendLspMessage(proc.stdout, {
        jsonrpc: "2.0",
        id: 200,
        method: "client/registerCapability",
        params: {},
      });

      await new Promise((r) => setTimeout(r, 50));

      const sent = Buffer.concat(chunks).toString("utf8");
      expect(sent).toContain('"id":200');
      expect(sent).toContain('"result":null');
    });
  });

  describe("dispose", () => {
    it("rejects all pending requests", async () => {
      const p1 = conn.sendRequest("method1", {});
      const p2 = conn.sendRequest("method2", {});

      conn.dispose();

      await expect(p1).rejects.toThrow("disposed");
      await expect(p2).rejects.toThrow("disposed");
    });
  });

  describe("message framing", () => {
    it("handles messages split across chunks", async () => {
      const promise = conn.sendRequest("test/method", {});

      const msg = JSON.stringify({ jsonrpc: "2.0", id: 1, result: "split" });
      const header = `Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n`;
      const full = header + msg;
      const mid = Math.floor(full.length / 2);

      proc.stdout.write(full.slice(0, mid));
      await new Promise((r) => setTimeout(r, 5));
      proc.stdout.write(full.slice(mid));

      const result = await promise;
      expect(result).toBe("split");
    });

    it("handles multiple messages in one chunk", async () => {
      const p1 = conn.sendRequest("m1", {});
      const p2 = conn.sendRequest("m2", {});

      const msg1 = JSON.stringify({ jsonrpc: "2.0", id: 1, result: "a" });
      const msg2 = JSON.stringify({ jsonrpc: "2.0", id: 2, result: "b" });
      const chunk =
        `Content-Length: ${Buffer.byteLength(msg1)}\r\n\r\n${msg1}` +
        `Content-Length: ${Buffer.byteLength(msg2)}\r\n\r\n${msg2}`;

      proc.stdout.write(chunk);

      expect(await p1).toBe("a");
      expect(await p2).toBe("b");
    });
  });
});
