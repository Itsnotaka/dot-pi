import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";

import type { Language } from "./roots.js";
import type { Diagnostic, PublishDiagnosticsParams } from "./types.js";

import { createConnection, type JsonRpcConnection } from "./jsonrpc.js";

export interface LspServer {
  language: Language;
  root: string;
  proc: ChildProcessWithoutNullStreams;
  conn: JsonRpcConnection;
  diagnostics: Map<string, Diagnostic[]>;
  waiters: Map<string, Array<() => void>>;
  ready: Promise<void>;
}

function which(cmd: string): string | null {
  try {
    const { execFileSync } = require("child_process");
    return execFileSync("which", [cmd], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

function resolveTsServer(root: string): { cmd: string; args: string[] } | null {
  const local = join(
    root,
    "node_modules",
    ".bin",
    "typescript-language-server"
  );
  if (existsSync(local)) return { cmd: local, args: ["--stdio"] };
  if (which("typescript-language-server"))
    return { cmd: "typescript-language-server", args: ["--stdio"] };
  return null;
}

function resolvePyServer(root: string): { cmd: string; args: string[] } | null {
  const localNpm = join(root, "node_modules", ".bin", "pyright-langserver");
  if (existsSync(localNpm)) return { cmd: localNpm, args: ["--stdio"] };
  if (which("pyright-langserver"))
    return { cmd: "pyright-langserver", args: ["--stdio"] };
  if (which("uv") && existsSync(join(root, "pyproject.toml")))
    return { cmd: "uv", args: ["run", "pyright-langserver", "--stdio"] };
  if (which("basedpyright-langserver"))
    return { cmd: "basedpyright-langserver", args: ["--stdio"] };
  return null;
}

export function resolveServer(
  lang: Language,
  root: string
): { cmd: string; args: string[] } | null {
  return lang === "typescript" ? resolveTsServer(root) : resolvePyServer(root);
}

export async function spawnServer(
  lang: Language,
  root: string
): Promise<LspServer> {
  const resolved = resolveServer(lang, root);
  if (!resolved) {
    const hint =
      lang === "typescript"
        ? "Install: pnpm i -g typescript-language-server typescript"
        : "Install: uv pip install pyright (or uv add pyright)";
    throw new Error(`No ${lang} language server found. ${hint}`);
  }

  const proc = spawn(resolved.cmd, resolved.args, {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  const conn = createConnection(proc);
  const diagnostics = new Map<string, Diagnostic[]>();
  const waiters = new Map<string, Array<() => void>>();

  conn.onNotification = (method, params) => {
    if (method === "textDocument/publishDiagnostics") {
      const p = params as PublishDiagnosticsParams;
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

  const rootUri = pathToFileURL(root).toString();

  const ready = conn
    .sendRequest("initialize", {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: root.split("/").pop() }],
      capabilities: {
        textDocument: {
          publishDiagnostics: { relatedInformation: true },
          synchronization: { didOpen: true, didChange: true, didClose: true },
        },
        workspace: {
          workspaceFolders: true,
          configuration: true,
        },
      },
    })
    .then(() => {
      conn.sendNotification("initialized", {});
    });

  return { language: lang, root, proc, conn, diagnostics, waiters, ready };
}

export async function shutdownServer(server: LspServer): Promise<void> {
  try {
    await server.conn.sendRequest("shutdown", null, 3000);
    server.conn.sendNotification("exit", null);
  } catch {}
  server.conn.dispose();
  server.proc.kill();
}
