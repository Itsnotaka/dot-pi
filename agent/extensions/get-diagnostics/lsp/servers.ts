import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "child_process";
import { existsSync } from "fs";
import { dirname, join, parse } from "path";
import { pathToFileURL } from "url";

import type { Language } from "./roots.js";
import type { Diagnostic, PublishDiagnosticsParams } from "./types.js";

import { createConnection, type JsonRpcConnection } from "./jsonrpc.js";

export type DiagnosticsServerId = "tsserver" | "oxlint" | "eslint" | "ty";

interface Resolved {
  cmd: string;
  args: string[];
}

export interface LspServer {
  id: DiagnosticsServerId;
  language: Language;
  root: string;
  proc: ChildProcessWithoutNullStreams;
  conn: JsonRpcConnection;
  diagnostics: Map<string, Diagnostic[]>;
  waiters: Map<string, Array<() => void>>;
  ready: Promise<void>;
  pullDiagnostics: boolean;
}

function which(cmd: string): string | null {
  try {
    return execFileSync("which", [cmd], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

function findBinUpward(root: string, bin: string): string | null {
  let dir = root;
  const { root: fsRoot } = parse(dir);
  while (dir !== fsRoot) {
    const candidate = join(dir, "node_modules", ".bin", bin);
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  return null;
}

function resolveLocalOrGlobal(root: string, bin: string): string | null {
  return findBinUpward(root, bin) ?? which(bin);
}

function resolveTsServer(root: string): Resolved | null {
  const bin = resolveLocalOrGlobal(root, "typescript-language-server");
  if (bin) return { cmd: bin, args: ["--stdio"] };
  const npx = which("npx");
  if (npx)
    return {
      cmd: npx,
      args: ["--yes", "typescript-language-server", "--stdio"],
    };
  return null;
}

function resolveOxlintServer(root: string): Resolved | null {
  const oxlint = resolveLocalOrGlobal(root, "oxlint");
  if (oxlint) return { cmd: oxlint, args: ["--lsp"] };

  const oxcServer = resolveLocalOrGlobal(root, "oxc_language_server");
  if (oxcServer) return { cmd: oxcServer, args: [] };

  return null;
}

function resolveEslintServer(root: string): Resolved | null {
  const bin = resolveLocalOrGlobal(root, "vscode-eslint-language-server");
  if (bin) return { cmd: bin, args: ["--stdio"] };
  const npx = which("npx");
  if (npx)
    return {
      cmd: npx,
      args: [
        "--yes",
        "--package=vscode-langservers-extracted",
        "vscode-eslint-language-server",
        "--stdio",
      ],
    };
  return null;
}

function resolveTyServer(_root: string): Resolved | null {
  const bin = which("ty");
  if (bin) return { cmd: bin, args: ["server"] };

  const uvx = which("uvx");
  if (uvx) return { cmd: uvx, args: ["ty", "server"] };

  return null;
}

const RESOLVERS: Record<DiagnosticsServerId, (root: string) => Resolved | null> = {
  tsserver: resolveTsServer,
  oxlint: resolveOxlintServer,
  eslint: resolveEslintServer,
  ty: resolveTyServer,
};

export function resolveServer(
  id: DiagnosticsServerId,
  root: string
): Resolved | null {
  return RESOLVERS[id](root);
}

export function serversForLanguage(
  lang: Language,
  root: string
): DiagnosticsServerId[] {
  if (lang === "python") return ["ty"];

  const ids: DiagnosticsServerId[] = ["tsserver"];

  if (resolveOxlintServer(root)) {
    ids.push("oxlint");
  } else if (resolveEslintServer(root)) {
    ids.push("eslint");
  }

  return ids;
}

const ESLINT_DEFAULT_CONFIG = {
  validate: "on",
  run: "onType",
  workingDirectory: { mode: "location" },
};

function languageForServer(id: DiagnosticsServerId): Language {
  return id === "ty" ? "python" : "typescript";
}

export async function spawnServer(
  id: DiagnosticsServerId,
  root: string
): Promise<LspServer> {
  const resolved = resolveServer(id, root);
  if (!resolved) {
    throw new Error(`No ${id} language server found for ${root}.`);
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

  conn.onRequest = async (method, params) => {
    if (method === "workspace/configuration") {
      const items = params?.items;
      if (id === "eslint") {
        if (Array.isArray(items)) return items.map(() => ESLINT_DEFAULT_CONFIG);
        return [ESLINT_DEFAULT_CONFIG];
      }
      if (Array.isArray(items)) return items.map(() => ({}));
      return [{}];
    }
    if (method === "client/registerCapability") return {};
    return null;
  };

  const rootUri = pathToFileURL(root).toString();

  let pullDiagnostics = false;

  const ready = conn
    .sendRequest("initialize", {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: root.split("/").pop() }],
      capabilities: {
        textDocument: {
          publishDiagnostics: { relatedInformation: true },
          diagnostic: { dynamicRegistration: false },
          synchronization: { didOpen: true, didChange: true, didClose: true },
        },
        workspace: {
          workspaceFolders: true,
          configuration: true,
        },
      },
    })
    .then((result: any) => {
      pullDiagnostics = !!result?.capabilities?.diagnosticProvider;
      conn.sendNotification("initialized", {});
    });

  const server: LspServer = {
    id,
    language: languageForServer(id),
    root,
    proc,
    conn,
    diagnostics,
    waiters,
    ready,
    pullDiagnostics: false,
  };

  ready.then(() => {
    server.pullDiagnostics = pullDiagnostics;
  });

  return server;
}

export async function shutdownServer(server: LspServer): Promise<void> {
  try {
    await server.conn.sendRequest("shutdown", null, 3000);
    server.conn.sendNotification("exit", null);
  } catch {}
  server.conn.dispose();
  server.proc.kill();
}
