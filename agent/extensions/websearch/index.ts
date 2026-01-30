/**
 * Parallel Search Tool
 *
 * Uses Parallel Search API to retrieve web results for a query/objective.
 *
 * Requires PARALLEL_API_KEY env var or .pi settings override.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_MAX_CHARS = 1500;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;
const API_URL = "https://api.parallel.ai/v1beta/search";
const BETA_HEADER = "search-extract-2025-10-10";
const SETTINGS_PATH = path.join(os.homedir(), ".pi", "agent", "settings.json");

type SearchResult = {
  url: string;
  title?: string | null;
  publish_date?: string | null;
  excerpts?: string[] | null;
};

type SearchResponse = {
  search_id?: string;
  results?: SearchResult[];
  warnings?: unknown;
};

type SearchParams = {
  objective: string;
  search_queries?: string[];
  max_results?: number;
  max_chars_per_result?: number;
};

type SpinnerDetails = {
  stage: "searching";
  spinnerIndex: number;
  objective: string;
  preview: string;
};

function shorten(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function formatResult(result: SearchResult, maxChars: number): string {
  const title = result.title?.trim() || result.url;
  const excerpt = result.excerpts?.[0]?.trim();
  if (!excerpt) return `${title}\n${result.url}`;
  return `${title}\n${result.url}\n${shorten(excerpt, maxChars)}`;
}

function loadApiKey(): string | null {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, "utf-8");
    const data = JSON.parse(raw) as { websearch?: { apiKey?: unknown } };
    const key = data.websearch?.apiKey;
    if (typeof key === "string" && key.trim()) {
      return key.trim();
    }
  } catch {
    return null;
  }
  return null;
}

function formatResultLine(result: SearchResult, theme: any): string {
  const title = result.title?.trim() || "";
  const desc = title ? shorten(title, 48) : "";
  const parts = [
    theme.fg("success", "✓"),
    " ",
    theme.fg("toolTitle", "Web Page "),
    theme.fg("accent", result.url),
  ];
  if (desc) parts.push(" ", theme.fg("muted", desc));
  return parts.join("");
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "websearch",
    label: "Web Search",
    description: "Search the web using Parallel Search API.",
    parameters: Type.Object({
      objective: Type.String({ description: "Search objective or question" }),
      search_queries: Type.Optional(Type.Array(Type.String(), { description: "Optional keyword queries" })),
      max_results: Type.Optional(Type.Number({ description: "Max results to return" })),
      max_chars_per_result: Type.Optional(Type.Number({ description: "Max chars per excerpt" })),
    }),

    async execute(_toolCallId, params, onUpdate, ctx, signal) {
      const { objective, search_queries, max_results, max_chars_per_result } = params as SearchParams;
      const apiKey = loadApiKey();
      if (!apiKey) {
        return {
          content: [
            {
              type: "text",
              text: `Missing API key. Set it in ${SETTINGS_PATH} under websearch.apiKey to use websearch.`,
            },
          ],
          details: { ok: false },
          isError: true,
        };
      }

      const preview = shorten(objective, 80);
      const canAnimate = !!onUpdate && ctx.hasUI;
      let spinnerIndex = 0;
      let spinnerTimer: ReturnType<typeof setInterval> | undefined;

      const stopSpinner = () => {
        if (spinnerTimer) {
          clearInterval(spinnerTimer);
          spinnerTimer = undefined;
        }
      };

      const emitSpinnerUpdate = () => {
        if (!onUpdate || !canAnimate) return;
        onUpdate({
          content: [{ type: "text", text: `Searching: ${preview}` }],
          details: {
            stage: "searching",
            spinnerIndex,
            objective,
            preview,
          } as SpinnerDetails,
        });
        spinnerIndex = (spinnerIndex + 1) % SPINNER_FRAMES.length;
      };

      if (canAnimate) {
        emitSpinnerUpdate();
        spinnerTimer = setInterval(emitSpinnerUpdate, SPINNER_INTERVAL_MS);
        signal?.addEventListener("abort", stopSpinner, { once: true });
      }

      try {
        const body = {
          objective,
          search_queries,
          max_results: max_results ?? DEFAULT_MAX_RESULTS,
          excerpts: { max_chars_per_result: max_chars_per_result ?? DEFAULT_MAX_CHARS },
        };

        const response = await fetch(API_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "parallel-beta": BETA_HEADER,
          },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const text = await response.text();
          return {
            content: [
              {
                type: "text",
                text: `Parallel Search API error (${response.status}): ${text}`,
              },
            ],
            details: { ok: false, status: response.status },
            isError: true,
          };
        }

        const data = (await response.json()) as SearchResponse;
        const results = data.results ?? [];
        const rendered = results
          .map((result, index) => `${index + 1}. ${formatResult(result, max_chars_per_result ?? DEFAULT_MAX_CHARS)}`)
          .join("\n\n");

        return {
          content: [{ type: "text", text: rendered || "(no results)" }],
          details: { ok: true, count: results.length, search_id: data.search_id ?? null, objective },
        };
      } finally {
        stopSpinner();
      }
    },

    renderCall(args, theme) {
      const objective = typeof args.objective === "string" ? args.objective : "";
      const preview = objective ? shorten(objective, 60) : "";
      const title = theme.fg("toolTitle", theme.bold("Web Search"));
      const detail = preview ? ` ${theme.fg("muted", "·")} ${theme.fg("muted", preview)}` : "";
      return new Text(`${title}${detail}`, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const details = result.details as
        | { count?: number; search_id?: string | null; spinnerIndex?: number; preview?: string; objective?: string }
        | undefined;
      const content = result.content?.[0];
      const raw = content?.type === "text" ? content.text : "(no results)";

      if (isPartial) {
        const spinnerIndex = details?.spinnerIndex ?? 0;
        const spinner = SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length] ?? "⠋";
        const text = `${theme.fg("accent", spinner)} ${theme.fg("thinkingText", "Searching web…")}`;
        return new Text(text, 0, 0);
      }

      // Parse result blocks
      const blocks = raw
        .split("\n\n")
        .map((block) => block.trim())
        .filter(Boolean);

      if (!expanded) {
        // Collapsed: single line with count + short URL list
        const count = details?.count ?? blocks.length;
        const urls = blocks
          .map((block) => {
            const lines = block.split("\n");
            const urlLine = lines.find((l) => l.startsWith("http"));
            if (!urlLine) return null;
            try {
              return new URL(urlLine).hostname.replace(/^www\./, "");
            } catch {
              return null;
            }
          })
          .filter(Boolean);
        const uniqueHosts = [...new Set(urls)].slice(0, 4);
        let text = `${theme.fg("success", "✓")} ${theme.fg("muted", `${count} results`)}`;
        if (uniqueHosts.length > 0) {
          text += theme.fg("dim", ` · ${uniqueHosts.join(", ")}`);
        }
        return new Text(text, 0, 0);
      }

      // Expanded: full result list
      const lines = blocks.map((block) => {
        const urlLine = block.split("\n")[1];
        return urlLine ? formatResultLine({ url: urlLine, title: block.split("\n")[0] }, theme) : block;
      });

      const header = details?.count
        ? `${theme.fg("success", "✓")} ${theme.fg("toolTitle", "Web Search ")}${theme.fg("muted", `(${details.count})`)}`
        : `${theme.fg("success", "✓")} ${theme.fg("toolTitle", "Web Search")}`;
      const rendered = [header, ...lines].join("\n");
      return new Text(rendered, 0, 0);
    },
  });
}
