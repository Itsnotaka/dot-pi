import type { ChildProcessWithoutNullStreams } from "child_process";

export type NotificationHandler = (method: string, params: any) => void;
export type RequestHandler = (method: string, params: any) => Promise<unknown>;

export interface JsonRpcConnection {
  sendRequest(method: string, params: any, timeoutMs?: number): Promise<any>;
  sendNotification(method: string, params: any): void;
  onNotification: NotificationHandler | null;
  onRequest: RequestHandler | null;
  dispose(): void;
}

export function createConnection(
  proc: ChildProcessWithoutNullStreams
): JsonRpcConnection {
  let nextId = 1;
  const pending = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let notificationHandler: NotificationHandler | null = null;
  let requestHandler: RequestHandler | null = null;
  let buffer = Buffer.alloc(0);

  function send(msg: unknown) {
    const json = JSON.stringify(msg);
    const len = Buffer.byteLength(json, "utf8");
    proc.stdin.write(`Content-Length: ${len}\r\n\r\n${json}`, "utf8");
  }

  function parseMessages() {
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const header = buffer.subarray(0, headerEnd).toString("utf8");
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        buffer = buffer.subarray(headerEnd + 4);
        continue;
      }

      const contentLen = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + contentLen) break;

      const body = buffer
        .subarray(bodyStart, bodyStart + contentLen)
        .toString("utf8");
      buffer = buffer.subarray(bodyStart + contentLen);

      try {
        void handleMessage(JSON.parse(body));
      } catch {}
    }
  }

  async function handleMessage(msg: any) {
    if ("id" in msg && "result" in msg) {
      const p = pending.get(msg.id);
      if (p) {
        clearTimeout(p.timer);
        pending.delete(msg.id);
        p.resolve(msg.result);
      }
    } else if ("id" in msg && "error" in msg) {
      const p = pending.get(msg.id);
      if (p) {
        clearTimeout(p.timer);
        pending.delete(msg.id);
        p.reject(new Error(msg.error?.message ?? "LSP error"));
      }
    } else if ("id" in msg && "method" in msg) {
      if (requestHandler) {
        try {
          const result = await requestHandler(msg.method, msg.params);
          send({ jsonrpc: "2.0", id: msg.id, result: result ?? null });
        } catch {
          send({ jsonrpc: "2.0", id: msg.id, result: null });
        }
      } else {
        send({ jsonrpc: "2.0", id: msg.id, result: null });
      }
    } else if ("method" in msg && !("id" in msg)) {
      notificationHandler?.(msg.method, msg.params);
    }
  }

  proc.stdout.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    parseMessages();
  });

  return {
    sendRequest(method, params, timeoutMs = 10000) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(
            new Error(`LSP request '${method}' timed out after ${timeoutMs}ms`)
          );
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        send({ jsonrpc: "2.0", id, method, params });
      });
    },
    sendNotification(method, params) {
      send({ jsonrpc: "2.0", method, params });
    },
    set onNotification(handler: NotificationHandler | null) {
      notificationHandler = handler;
    },
    get onNotification() {
      return notificationHandler;
    },
    set onRequest(handler: RequestHandler | null) {
      requestHandler = handler;
    },
    get onRequest() {
      return requestHandler;
    },
    dispose() {
      for (const [, p] of pending) {
        clearTimeout(p.timer);
        p.reject(new Error("Connection disposed"));
      }
      pending.clear();
    },
  };
}
