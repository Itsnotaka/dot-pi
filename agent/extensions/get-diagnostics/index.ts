/**
 * LSP diagnostics tool — on-demand typecheck/syntax check.
 *
 * Supports multiple LSP servers per file:
 *   JS/TS: tsserver + oxfmt + oxlint/eslint
 *   Python: ty (astral-sh/ty)
 *   Go: gopls
 *   YAML: yaml-language-server
 *   Astro: astro-ls
 *   Markdown: marksman (if installed)
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

const SeverityFilterSchema = StringEnum(["error", "warning", "info", "hint", "all"] as const, {
  description: "Filter diagnostics by severity. Default: error.",
  default: "error",
});

const GetDiagnosisParams = Type.Object({
  path: Type.String({
    description: "File path to check (absolute or relative to cwd)",
  }),
  severity: Type.Optional(SeverityFilterSchema),
  max_chars: Type.Optional(
    Type.Number({
      description: "Max characters to return (default: 4000)",
    }),
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
  const broken = new Map<string, string>();

  function getErrorMessage(error: unknown, fallback: string): string {
    if (error instanceof Error && error.message) return error.message;
    return fallback;
  }

  async function getOrSpawnServer(
    id: DiagnosticsServerId,
    root: string,
  ): Promise<LspServer | null> {
    const key = `${id}:${root}`;
    if (broken.has(key)) return null;

    let server = servers.get(key);
    if (!server) {
      try {
        server = await spawnServer(id, root);
      } catch (error) {
        broken.set(key, getErrorMessage(error, `${id} spawn failed`));
        return null;
      }

      servers.set(key, server);
      server.proc.on("exit", () => servers.delete(key));
    }

    try {
      await server.ready;
      return server;
    } catch (error) {
      broken.set(key, getErrorMessage(error, `${id} initialize failed`));
      servers.delete(key);
      await shutdownServer(server).catch(() => {});
      return null;
    }
  }

  async function getAllDiagnostics(
    abs: string,
    root: string,
    serverIds: DiagnosticsServerId[],
  ): Promise<{
    diagnostics: Diagnostic[];
    activeServers: string[];
    errors: string[];
  }> {
    const spawnResults = await Promise.all(serverIds.map((id) => getOrSpawnServer(id, root)));
    const active = spawnResults.filter((s): s is LspServer => s !== null);

    if (active.length === 0) {
      const errors = serverIds
        .map((id) => broken.get(`${id}:${root}`))
        .filter((reason): reason is string => !!reason);
      return { diagnostics: [], activeServers: [], errors };
    }

    const settled = await Promise.allSettled(
      active.map((s) =>
        getDiagnosticsForFile(s, abs).then((diags) =>
          diags.map((d) => ({ ...d, source: d.source ?? s.id })),
        ),
      ),
    );

    const diagnostics = settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []));

    return {
      diagnostics,
      activeServers: active.map((s) => s.id),
      errors: [],
    };
  }

  pi.registerTool({
    name: "get_diagnosis",
    label: "Get Diagnosis",
    description:
      "Run LSP diagnostics for a file (typecheck/syntax check). " +
      "Provide a file path to analyze on demand.",
    parameters: GetDiagnosisParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
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
      const {
        diagnostics: allDiags,
        activeServers,
        errors,
      } = await getAllDiagnostics(abs, root, serverIds);

      if (activeServers.length === 0) {
        const reason = errors[0];
        const reasonText = reason ? ` Reason: ${reason}` : "";
        return {
          content: [
            {
              type: "text",
              text: `Diagnostics unavailable for ${abs} (tried: ${serverIds.join(", ")}).${reasonText}`,
            },
          ],
          details: {
            ok: false,
            reason: "no_server",
            path: abs,
            root,
            lang,
            tried: serverIds,
            errors,
          },
          isError: true,
        };
      }

      const filter = severity ?? "error";
      const filtered =
        filter === "all"
          ? allDiags
          : allDiags.filter((d) => (d.severity ?? 1) === SEVERITY_LEVELS[filter]);
      const emptyMessage =
        filter === "all" ? "No diagnostics found." : `No ${filter} diagnostics found.`;

      if (filtered.length === 0) {
        return {
          content: [{ type: "text", text: emptyMessage }],
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
    broken.clear();
  });
}
