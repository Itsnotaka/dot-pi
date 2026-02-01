import { readFileSync } from "fs";
import { pathToFileURL } from "url";

import type { LspServer } from "./servers.js";
import type { Diagnostic } from "./types.js";

const LANG_IDS: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".py": "python",
  ".pyi": "python",
};

const DIAGNOSTICS_DEBOUNCE_MS = 50;
const DIAGNOSTICS_TIMEOUT_MS = 5000;

function getLanguageId(file: string): string {
  const ext = file.slice(file.lastIndexOf("."));
  return LANG_IDS[ext] ?? "plaintext";
}

export async function getDiagnosticsForFile(
  server: LspServer,
  file: string
): Promise<Diagnostic[]> {
  await server.ready;

  const uri = pathToFileURL(file).toString();
  const languageId = getLanguageId(file);

  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }

  server.conn.sendNotification("textDocument/didOpen", {
    textDocument: { uri, languageId, version: 1, text },
  });

  await waitForDiagnostics(server, file);

  server.conn.sendNotification("textDocument/didClose", {
    textDocument: { uri },
  });

  return server.diagnostics.get(file) ?? [];
}

function waitForDiagnostics(server: LspServer, file: string): Promise<void> {
  return new Promise<void>((resolve) => {
    let debounce: ReturnType<typeof setTimeout> | null = null;

    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, DIAGNOSTICS_TIMEOUT_MS);

    const cb = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        cleanup();
        resolve();
      }, DIAGNOSTICS_DEBOUNCE_MS);
    };

    function cleanup() {
      clearTimeout(timeout);
      if (debounce) clearTimeout(debounce);
      const fns = server.waiters.get(file);
      if (fns) {
        const idx = fns.indexOf(cb);
        if (idx !== -1) fns.splice(idx, 1);
        if (fns.length === 0) server.waiters.delete(file);
      }
    }

    if (!server.waiters.has(file)) server.waiters.set(file, []);
    server.waiters.get(file)!.push(cb);
  });
}
