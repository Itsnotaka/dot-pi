/**
 * LSP diagnostics extension — append errors after edit/write.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { isAbsolute, resolve } from "path";

import { getDiagnosticsForFile } from "./lsp/lspClient.js";
import { detectLanguage, findRootForLanguage } from "./lsp/roots.js";
import { shutdownServer, spawnServer, type LspServer } from "./lsp/servers.js";
import { prettyDiagnostic } from "./lsp/types.js";

const MAX_DIAG_LENGTH = 4000;

export default function (pi: ExtensionAPI) {
  const servers = new Map<string, LspServer>();
  const broken = new Set<string>();

  async function getOrSpawnServer(
    lang: "typescript" | "python",
    root: string
  ): Promise<LspServer | null> {
    const key = `${lang}:${root}`;
    if (broken.has(key)) return null;

    let server = servers.get(key);
    if (server) return server;

    try {
      server = await spawnServer(lang, root);
    } catch {
      broken.add(key);
      return null;
    }

    servers.set(key, server);
    server.proc.on("exit", () => servers.delete(key));
    return server;
  }

  pi.on("tool_result", async (event: any, ctx: any) => {
    if (event.isError) return;
    if (event.toolName !== "edit" && event.toolName !== "write") return;

    const filePath = event.input?.path as string;
    if (!filePath) return;

    const abs = isAbsolute(filePath) ? filePath : resolve(ctx.cwd, filePath);
    const lang = detectLanguage(abs);
    if (!lang) return;

    const root = findRootForLanguage(abs, lang) ?? ctx.cwd;
    const server = await getOrSpawnServer(lang, root);
    if (!server) return;

    try {
      const diags = await getDiagnosticsForFile(server, abs);
      const errors = diags.filter((d) => d.severity === 1);

      if (errors.length > 0) {
        let diagText = errors.map((d) => prettyDiagnostic(abs, d)).join("\n");
        if (diagText.length > MAX_DIAG_LENGTH) {
          diagText = diagText.slice(0, MAX_DIAG_LENGTH) + "\n... (truncated)";
        }

        const existing = event.content ?? [];
        return {
          content: [
            ...existing,
            {
              type: "text",
              text: `\n\nLSP errors detected, please fix:\n${diagText}`,
            },
          ],
          details: event.details,
        };
      }
    } catch {}
  });

  pi.on("session_shutdown", async () => {
    for (const server of servers.values()) {
      await shutdownServer(server).catch(() => {});
    }
    servers.clear();
  });
}
