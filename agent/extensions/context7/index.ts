/**
 * Context7 Search Extension
 *
 * Searches GitHub repos/packages documentation via Context7 REST API.
 * Two-step flow: resolve library → fetch docs.
 *
 * Requires CONTEXT7_API_KEY env var or settings.json override.
 * Get a free key at https://context7.com/dashboard
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import {
  createSpinnerTicker,
  getSpinnerFrame,
  resolveApiKey,
  SETTINGS_PATH,
} from "../shared/web-infra.js";

const BASE_URL = "https://context7.com/api";

// ── Types ────────────────────────────────────────────────────────────

type Library = {
  id: string;
  name: string;
  description: string;
  totalSnippets: number;
  trustScore: number;
  benchmarkScore: number;
  versions?: string[];
};

type ApiSearchResponse = {
  results: Array<{
    id: string;
    title?: string;
    name?: string;
    description: string;
    totalSnippets: number;
    trustScore: number;
    benchmarkScore: number;
    versions?: string[];
  }>;
};

type SearchParams = {
  libraryName: string;
  query: string;
  topic?: string;
  tokens?: number;
};

type SpinnerDetails = {
  stage: "searching" | "fetching";
  libraryName: string;
  queryPreview: string;
  spinnerIndex: number;
};

// ── Helpers ──────────────────────────────────────────────────────────

function loadApiKey(): string | null {
  return resolveApiKey("context7", "CONTEXT7_API_KEY");
}

function shorten(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

async function apiGet<T>(
  endpoint: string,
  query: Record<string, string | number | undefined>,
  apiKey: string
): Promise<T> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) params.append(k, String(v));
  }
  const url = `${BASE_URL}/${endpoint}?${params}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Context7 API error (${res.status}): ${text}`);
  }
  return res.json() as Promise<T>;
}

async function searchLibraries(
  apiKey: string,
  query: string,
  libraryName: string
): Promise<Library[]> {
  const data = await apiGet<ApiSearchResponse>(
    "v2/libs/search",
    { query, libraryName },
    apiKey
  );
  return data.results.map((r) => ({
    id: r.id,
    name: r.title || r.name || r.id,
    description: r.description,
    totalSnippets: r.totalSnippets,
    trustScore: r.trustScore,
    benchmarkScore: r.benchmarkScore,
    versions: r.versions,
  }));
}

async function getContext(
  apiKey: string,
  query: string,
  libraryId: string
): Promise<string> {
  const params = new URLSearchParams();
  params.append("query", query);
  params.append("libraryId", libraryId);
  params.append("type", "txt");
  const url = `${BASE_URL}/v2/context?${params}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Context7 API error (${res.status}): ${text}`);
  }
  return res.text();
}

// ── Extension ────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "context7-search",
    label: "Context7 Search",
    description:
      "Search for up-to-date documentation and code examples for GitHub repos and packages (e.g. React, Next.js, Express, etc). " +
      "Use this tool ONLY for looking up library/package/framework documentation from their source repositories. " +
      "Provide a library name to search, and a query describing what you need. " +
      "Returns version-specific docs and working code examples pulled directly from official sources.",
    parameters: Type.Object({
      libraryName: Type.String({
        description:
          "Name of the library/package to search (e.g. 'react', 'next.js', 'express')",
      }),
      query: Type.String({
        description:
          "What you need from the docs — your question or task (e.g. 'how to use server components', 'middleware setup')",
      }),
      topic: Type.Optional(
        Type.String({
          description:
            "Optional topic filter (e.g. 'routing', 'hooks', 'middleware')",
        })
      ),
      tokens: Type.Optional(
        Type.Number({
          description: "Max tokens of documentation to return (default 5000)",
        })
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const { libraryName, query, topic } = params as SearchParams;
      const apiKey = loadApiKey();
      if (!apiKey) {
        return {
          content: [
            {
              type: "text",
              text: `Missing Context7 API key. Set it in ${SETTINGS_PATH} under context7.apiKey, or set CONTEXT7_API_KEY env var.\nGet a free key at https://context7.com/dashboard`,
            },
          ],
          details: {
            ok: false,
            mode: "docs",
            provider: "context7",
            fallbackUsed: false,
            degraded: false,
          },
          isError: true,
        };
      }

      const searchQuery = topic ? `${query} ${topic}` : query;
      const queryPreview = shorten(searchQuery, 60);
      const canAnimate = !!onUpdate && ctx.hasUI;
      let spinnerStage: SpinnerDetails["stage"] = "searching";
      let spinnerLibrary = libraryName;

      const stopSpinner = createSpinnerTicker(
        canAnimate,
        (spinnerIndex) => {
          const label =
            spinnerStage === "fetching"
              ? `Fetching docs: ${spinnerLibrary}`
              : `Searching libraries: ${spinnerLibrary} — ${queryPreview}`;

          onUpdate?.({
            content: [{ type: "text", text: label }],
            details: {
              stage: spinnerStage,
              libraryName: spinnerLibrary,
              queryPreview,
              spinnerIndex,
            } as SpinnerDetails,
          });
        },
        signal
      );

      const startedAt = Date.now();

      try {
        // Step 1: resolve library ID
        const libraries = await searchLibraries(
          apiKey,
          searchQuery,
          libraryName
        );

        if (!libraries.length) {
          return {
            content: [
              {
                type: "text",
                text: `No libraries found matching "${libraryName}".`,
              },
            ],
            details: {
              ok: true,
              mode: "docs",
              provider: "context7",
              fallbackUsed: false,
              degraded: false,
              count: 0,
              latencyMs: Date.now() - startedAt,
            },
          };
        }

        // Pick best match (first result, highest ranked by Context7)
        const lib = libraries[0];
        const libraryDisplayName =
          lib.name?.trim() || libraryName.trim() || lib.id;

        spinnerStage = "fetching";
        spinnerLibrary = libraryDisplayName;

        // Step 2: get documentation
        const docs = await getContext(apiKey, searchQuery, lib.id);

        const header = `Library: ${libraryDisplayName} (${lib.id})\nSnippets: ${lib.totalSnippets} | Trust: ${lib.trustScore}/10\n${lib.description}\n${"─".repeat(60)}\n`;
        const result = header + docs;

        return {
          content: [{ type: "text", text: result }],
          details: {
            ok: true,
            mode: "docs",
            provider: "context7",
            fallbackUsed: false,
            degraded: false,
            libraryId: lib.id,
            libraryName: libraryDisplayName,
            matchCount: libraries.length,
            latencyMs: Date.now() - startedAt,
          },
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Context7 error: ${message}` }],
          details: {
            ok: false,
            mode: "docs",
            provider: "context7",
            fallbackUsed: false,
            degraded: false,
            latencyMs: Date.now() - startedAt,
          },
          isError: true,
        };
      } finally {
        stopSpinner();
      }
    },

    renderCall(args, theme) {
      const lib =
        typeof args.libraryName === "string" ? args.libraryName : "...";
      const query = typeof args.query === "string" ? args.query : "";
      const topic = typeof args.topic === "string" ? args.topic : "";
      const preview = shorten(topic ? `${query} ${topic}` : query, 60);
      const title = theme.fg("toolTitle", theme.bold("Context7"));
      const library = theme.fg("accent", lib);
      const detail = preview ? ` ${theme.fg("muted", `— ${preview}`)}` : "";
      return new Text(`${title} ${library}${detail}`, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const details = result.details as
        | {
            ok?: boolean;
            libraryId?: string;
            libraryName?: string;
            matchCount?: number;
            stage?: SpinnerDetails["stage"];
            queryPreview?: string;
            spinnerIndex?: number;
          }
        | undefined;
      const content = result.content?.[0];
      const raw = content?.type === "text" ? content.text : "(no results)";

      if (isPartial) {
        const spinner = getSpinnerFrame(details?.spinnerIndex ?? 0);
        const stageLabel =
          details?.stage === "fetching"
            ? "Fetching docs:"
            : "Searching libraries:";
        const name = details?.libraryName ?? "...";
        const queryPreview = details?.queryPreview ?? "";
        let text =
          `${theme.fg("accent", spinner)} ` +
          `${theme.fg("toolTitle", "Context7")} ` +
          `${theme.fg("thinkingText", stageLabel)} ` +
          `${theme.fg("accent", name)}`;
        if (queryPreview && details?.stage !== "fetching") {
          text += theme.fg("muted", ` — ${queryPreview}`);
        }
        return new Text(text, 0, 0);
      }

      if (!expanded) {
        if (!details?.ok) {
          return new Text(
            `${theme.fg("error", "✗")} ${theme.fg("muted", "◇ Context7 error")}`,
            0,
            0
          );
        }
        const name = details?.libraryName ?? "unknown";
        const id = details?.libraryId ?? "";
        return new Text(
          `${theme.fg("success", "✓")} ${theme.fg("toolTitle", "◇ Context7 ")}${theme.fg("accent", name)} ${theme.fg("muted", id)}`,
          0,
          0
        );
      }

      // Expanded: show full docs
      const header = details?.libraryName
        ? `${theme.fg("success", "✓")} ${theme.fg("toolTitle", "◇ Context7 ")}${theme.fg("accent", details.libraryName)} ${theme.fg("muted", details.libraryId ?? "")}`
        : `${theme.fg("success", "✓")} ${theme.fg("toolTitle", "◇ Context7")}`;

      // Truncate displayed output to keep TUI responsive
      const preview =
        raw.length > 2000 ? raw.slice(0, 2000) + "\n…(truncated)" : raw;
      return new Text(`${header}\n${theme.fg("muted", preview)}`, 0, 0);
    },
  });
}
