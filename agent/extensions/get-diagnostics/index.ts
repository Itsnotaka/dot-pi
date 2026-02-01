/**
 * LSP diagnostics tool — on-demand typecheck/syntax check.
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { isAbsolute, resolve } from "path";

import { getDiagnosticsForFile } from "./lsp/lspClient.js";
import { detectLanguage, findRootForLanguage } from "./lsp/roots.js";
import { shutdownServer, spawnServer, type LspServer } from "./lsp/servers.js";
import { prettyDiagnostic } from "./lsp/types.js";

const MAX_DIAG_LENGTH = 4000;

const SeverityFilterSchema = StringEnum(
  ["error", "warning", "info", "hint", "all"] as const,
  {
    description: "Filter diagnostics by severity. Default: error.",
    default: "error",
  }
);

const GetDiagnosisParams = Type.Object({
  path: Type.String({
    description: "File path to check (absolute or relative to cwd)",
  }),
  severity: Type.Optional(SeverityFilterSchema),
  max_chars: Type.Optional(
    Type.Number({
      description: "Max characters to return (default: 4000)",
    })
  ),
});

type SeverityFilter =
  | "error"
  | "warning"
  | "info"
  | "hint"
  | "all";

const SEVERITY_LEVELS: Record<Exclude<SeverityFilter, "all">, number> = {
  error: 1,
  warning: 2,
  info: 3,
  hint: 4,
};

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

  pi.registerTool({
    name: "get_diagnosis",
    label: "Get Diagnosis",
    description:
      "Run LSP diagnostics for a file (typecheck/syntax check). " +
      "Provide a file path to analyze on demand.",
    parameters: GetDiagnosisParams,

    async execute(_toolCallId, params, _onUpdate, ctx) {
      const { path, severity, max_chars } = params as {
        path: string;
        severity?: SeverityFilter;
        max_chars?: number;
      };

      const abs = isAbsolute(path) ? path : resolve(ctx.cwd, path);
      const lang = detectLanguage(abs);
      if (!lang) {
        return {
          content: [
            {
              type: "text",
              text: `Unsupported file type for diagnostics: ${abs}`,
            },
          ],
          details: { ok: false, reason: "unsupported_language", path: abs },
          isError: true,
        };
      }

      const root = findRootForLanguage(abs, lang) ?? ctx.cwd;
      const server = await getOrSpawnServer(lang, root);
      if (!server) {
        return {
          content: [
            {
              type: "text",
              text: `No ${lang} language server available for ${root}.`,
            },
          ],
          details: { ok: false, reason: "no_server", path: abs, root, lang },
          isError: true,
        };
      }

      try {
        const diags = await getDiagnosticsForFile(server, abs);
        const filter = severity ?? "error";
        const filtered =
          filter === "all"
            ? diags
            : diags.filter((d) => (d.severity ?? 1) === SEVERITY_LEVELS[filter]);

        if (filtered.length === 0) {
          return {
            content: [{ type: "text", text: `No ${filter} diagnostics.` }],
            details: {
              ok: true,
              path: abs,
              root,
              lang,
              severity: filter,
              count: 0,
            },
          };
        }

        let diagText = filtered.map((d) => prettyDiagnostic(abs, d)).join("\n");
        const limit = max_chars ?? MAX_DIAG_LENGTH;
        if (diagText.length > limit) {
          diagText = diagText.slice(0, limit) + "\n... (truncated)";
        }

        return {
          content: [
            {
              type: "text",
              text: `Diagnostics (${filtered.length}) for ${abs}:\n${diagText}`,
            },
          ],
          details: {
            ok: true,
            path: abs,
            root,
            lang,
            severity: filter,
            count: filtered.length,
          },
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to run diagnostics";
        return {
          content: [{ type: "text", text: message }],
          details: { ok: false, reason: "diagnostics_failed", path: abs },
          isError: true,
        };
      }
    },
  });

  pi.on("session_shutdown", async () => {
    for (const server of servers.values()) {
      await shutdownServer(server).catch(() => {});
    }
    servers.clear();
  });
}
