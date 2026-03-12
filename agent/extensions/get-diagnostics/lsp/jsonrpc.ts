import type { ChildProcessWithoutNullStreams } from "child_process";

export type NotificationHandler = (method: string, params: any) => void;

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type RequestHandlerResponse =
  | { kind: "result"; value: unknown }
  | { kind: "error"; error: JsonRpcError };

export type RequestHandler = (
  method: string,
  params: any
) => Promise<RequestHandlerResponse>;

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
  let disposed = false;
  let stderr = "";

  function send(msg: unknown) {
    const json = JSON.stringify(msg);
    const len = Buffer.byteLength(json, "utf8");
    proc.stdin.write(`Content-Length: ${len}\r\n\r\n${json}`, "utf8");
  }

  function rejectPending(error: Error) {
    if (pending.size === 0) return;
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    pending.clear();
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
          const response = await requestHandler(msg.method, msg.params);
          if (response.kind === "error") {
            send({ jsonrpc: "2.0", id: msg.id, error: response.error });
          } else {
            send({ jsonrpc: "2.0", id: msg.id, result: response.value ?? null });
          }
        } catch (error) {
          send({
            jsonrpc: "2.0",
            id: msg.id,
            error: {
              code: -32603,
              message:
                error instanceof Error && error.message
                  ? error.message
                  : "Internal error",
            },
          });
        }
      } else {
        send({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: `Method not found: ${msg.method}` },
        });
      }
    } else if ("method" in msg && !("id" in msg)) {
      notificationHandler?.(msg.method, msg.params);
    }
  }

  proc.stdout.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    parseMessages();
  });

  proc.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
    if (stderr.length > 4000) {
      stderr = stderr.slice(-4000);
    }
  });

  proc.on("exit", (code, signal) => {
    if (disposed) return;
    const details = stderr.trim();
    const reason = details
      ? `LSP process exited${code !== null ? ` with code ${code}` : ""}${signal ? ` (signal ${signal})` : ""}: ${details}`
      : `LSP process exited${code !== null ? ` with code ${code}` : ""}${signal ? ` (signal ${signal})` : ""}`;
    rejectPending(new Error(reason));
  });

  proc.on("error", (error) => {
    if (disposed) return;
    rejectPending(
      error instanceof Error ? error : new Error(String(error ?? "LSP process error"))
    );
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
      disposed = true;
      rejectPending(new Error("Connection disposed"));
    },
  };
}
