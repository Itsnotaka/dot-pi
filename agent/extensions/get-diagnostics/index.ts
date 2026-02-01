/**
 * LSP diagnostics tool — on-demand typecheck/syntax check.
 *
 * Supports multiple LSP servers per file:
 *   JS/TS: tsserver + oxlint + eslint
 *   Python: pyright
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { isAbsolute, resolve } from "path";

import { getDiagnosticsForFile } from "./lsp/lspClient.js";
import { detectLanguage, findRootForLanguage } from "./lsp/roots.js";
import {
  serversForLanguage,
  shutdownServer,
  spawnServer,
  type DiagnosticsServerId,
  type LspServer,
} from "./lsp/servers.js";
import { prettyDiagnostic, type Diagnostic } from "./lsp/types.js";

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

type SeverityFilter = "error" | "warning" | "info" | "hint" | "all";

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
    id: DiagnosticsServerId,
    root: string
  ): Promise<LspServer | null> {
    const key = `${id}:${root}`;
    if (broken.has(key)) return null;

    let server = servers.get(key);
    if (server) return server;

    try {
      server = await spawnServer(id, root);
    } catch {
      broken.add(key);
      return null;
    }

    servers.set(key, server);
    server.proc.on("exit", () => servers.delete(key));
    return server;
  }

  async function getAllDiagnostics(
    abs: string,
    root: string,
    serverIds: DiagnosticsServerId[]
  ): Promise<{ diagnostics: Diagnostic[]; activeServers: string[] }> {
    const spawnResults = await Promise.all(
      serverIds.map((id) => getOrSpawnServer(id, root))
    );
    const active = spawnResults.filter((s): s is LspServer => s !== null);

    if (active.length === 0) {
      return { diagnostics: [], activeServers: [] };
    }

    const settled = await Promise.allSettled(
      active.map((s) =>
        getDiagnosticsForFile(s, abs).then((diags) =>
          diags.map((d) => ({ ...d, source: d.source ?? s.id }))
        )
      )
    );

    const diagnostics = settled.flatMap((r) =>
      r.status === "fulfilled" ? r.value : []
    );

    return {
      diagnostics,
      activeServers: active.map((s) => s.id),
    };
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
      const serverIds = serversForLanguage(lang, root);
      const { diagnostics: allDiags, activeServers } = await getAllDiagnostics(
        abs,
        root,
        serverIds
      );

      if (activeServers.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No language servers available for ${abs} (tried: ${serverIds.join(", ")}).`,
            },
          ],
          details: {
            ok: false,
            reason: "no_server",
            path: abs,
            root,
            lang,
            tried: serverIds,
          },
          isError: true,
        };
      }

      const filter = severity ?? "error";
      const filtered =
        filter === "all"
          ? allDiags
          : allDiags.filter(
              (d) => (d.severity ?? 1) === SEVERITY_LEVELS[filter]
            );

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
            servers: activeServers,
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
          servers: activeServers,
        },
      };
    },
  });

  pi.on("session_shutdown", async () => {
    for (const server of servers.values()) {
      await shutdownServer(server).catch(() => {});
    }
    servers.clear();
  });
}
