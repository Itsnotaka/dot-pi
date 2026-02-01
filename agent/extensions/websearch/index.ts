/**
 * Parallel Search + direct URL fetch tool.
 *
 * Requires PARALLEL_API_KEY env var or .pi settings override for search.
 * URLs passed in the query are fetched directly (no API key needed).
 */

import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";

import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_MAX_CHARS = 1500;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;
const API_URL = "https://api.parallel.ai/v1beta/search";
const BETA_HEADER = "search-extract-2025-10-10";
const SETTINGS_PATH = path.join(os.homedir(), ".pi", "agent", "settings.json");

const MAX_FETCH_SIZE = 5 * 1024 * 1024; // 5MB
const DEFAULT_FETCH_TIMEOUT = 30_000;

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
  query: string;
  max_results?: number;
  max_chars_per_result?: number;
};

type SpinnerDetails = {
  stage: "searching" | "fetching";
  spinnerIndex: number;
  query: string;
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

function formatResultLine(result: SearchResult, theme: Theme): string {
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

function isUrl(text: string): boolean {
  const trimmed = text.trim();
  return /^https?:\/\/\S+$/i.test(trimmed);
}

function htmlToMarkdown(html: string): string {
  let text = html;

  text = text.replace(
    /<(script|style|noscript|svg|iframe)[^>]*>[\s\S]*?<\/\1>/gi,
    ""
  );

  text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n");
  text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n");
  text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n");
  text = text.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n");
  text = text.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, "\n##### $1\n");
  text = text.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, "\n###### $1\n");

  text = text.replace(
    /<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
    "[$2]($1)"
  );
  text = text.replace(
    /<img[^>]*alt="([^"]*)"[^>]*src="([^"]*)"[^>]*\/?>/gi,
    "![$1]($2)"
  );
  text = text.replace(
    /<img[^>]*src="([^"]*)"[^>]*alt="([^"]*)"[^>]*\/?>/gi,
    "![$2]($1)"
  );
  text = text.replace(/<img[^>]*src="([^"]*)"[^>]*\/?>/gi, "![]($1)");

  text = text.replace(
    /<pre[^>]*><code[^>]*class="[^"]*language-(\w+)"[^>]*>([\s\S]*?)<\/code><\/pre>/gi,
    "\n```$1\n$2\n```\n"
  );
  text = text.replace(
    /<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi,
    "\n```\n$1\n```\n"
  );
  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, "\n```\n$1\n```\n");
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");

  text = text.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**");
  text = text.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*");
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n");
  text = text.replace(
    /<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi,
    (_, content) => {
      return (
        content
          .split("\n")
          .map((line: string) => `> ${line}`)
          .join("\n") + "\n"
      );
    }
  );

  text = text.replace(/<hr[^>]*\/?>/gi, "\n---\n");
  text = text.replace(/<br[^>]*\/?>/gi, "\n");
  text = text.replace(
    /<\/(p|div|section|article|header|footer|main|nav|aside)>/gi,
    "\n\n"
  );
  text = text.replace(
    /<(p|div|section|article|header|footer|main|nav|aside)[^>]*>/gi,
    ""
  );

  text = text.replace(/<\/td>/gi, " | ");
  text = text.replace(/<\/th>/gi, " | ");
  text = text.replace(/<tr[^>]*>/gi, "| ");
  text = text.replace(/<\/tr>/gi, "\n");

  text = text.replace(/<[^>]+>/g, "");

  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, " ");
  text = text.replace(/&#(\d+);/g, (_, code) =>
    String.fromCharCode(Number(code))
  );
  text = text.replace(/&\w+;/g, "");

  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.trim();

  return text;
}

function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return null;
  return match[1].replace(/<[^>]+>/g, "").trim() || null;
}

async function fetchUrl(
  url: string,
  signal?: AbortSignal
): Promise<{ content: string; title: string | null; contentType: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_FETCH_TIMEOUT);
  const combinedSignal = signal
    ? AbortSignal.any([controller.signal, signal])
    : controller.signal;

  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  };

  const initial = await fetch(url, {
    signal: combinedSignal,
    headers,
    redirect: "follow",
  });

  const response =
    initial.status === 403 &&
    initial.headers.get("cf-mitigated") === "challenge"
      ? await fetch(url, {
          signal: combinedSignal,
          headers: { ...headers, "User-Agent": "pi-agent" },
          redirect: "follow",
        })
      : initial;

  clearTimeout(timeoutId);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength && parseInt(contentLength) > MAX_FETCH_SIZE) {
    throw new Error("Response too large (exceeds 5MB limit)");
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_FETCH_SIZE) {
    throw new Error("Response too large (exceeds 5MB limit)");
  }

  const raw = new TextDecoder().decode(arrayBuffer);
  const contentType = response.headers.get("content-type") || "";

  let title: string | null = null;
  let content: string;

  if (
    contentType.includes("text/html") ||
    contentType.includes("application/xhtml")
  ) {
    title = extractTitle(raw);
    content = htmlToMarkdown(raw);
  } else {
    content = raw;
  }

  return { content, title, contentType };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "websearch",
    label: "Web Search",
    description:
      "Search the web or fetch a URL. " +
      "Provide a URL (starting with http:// or https://) to fetch that page directly, " +
      "or provide search terms/question to search the web.",
    parameters: Type.Object({
      query: Type.String({
        description: "URL to fetch or search query/keywords",
      }),
      max_results: Type.Optional(
        Type.Number({ description: "Max results to return" })
      ),
      max_chars_per_result: Type.Optional(
        Type.Number({ description: "Max chars per excerpt" })
      ),
    }),

    async execute(_toolCallId, params, onUpdate, ctx, signal) {
      const { query, max_results, max_chars_per_result } =
        params as SearchParams;
      const directUrl = isUrl(query);

      const preview = shorten(query, 80);
      const canAnimate = !!onUpdate && ctx.hasUI;
      let spinnerIndex = 0;
      let spinnerTimer: ReturnType<typeof setInterval> | undefined;

      const stopSpinner = () => {
        if (spinnerTimer) {
          clearInterval(spinnerTimer);
          spinnerTimer = undefined;
        }
      };

      const emitSpinnerUpdate = (stage: "searching" | "fetching") => {
        if (!onUpdate || !canAnimate) return;
        onUpdate({
          content: [
            {
              type: "text",
              text: stage === "fetching" ? "Fetching…" : "Searching…",
            },
          ],
          details: {
            stage,
            spinnerIndex,
            query,
            preview,
          } as SpinnerDetails,
        });
        spinnerIndex = (spinnerIndex + 1) % SPINNER_FRAMES.length;
      };

      if (canAnimate) {
        emitSpinnerUpdate(directUrl ? "fetching" : "searching");
        spinnerTimer = setInterval(
          () => emitSpinnerUpdate(directUrl ? "fetching" : "searching"),
          SPINNER_INTERVAL_MS
        );
        signal?.addEventListener("abort", stopSpinner, { once: true });
      }

      try {
        if (directUrl) {
          const url = query.trim();
          const { content, title, contentType } = await fetchUrl(url, signal);
          const header = title
            ? `${title}\n${url} (${contentType})\n\n`
            : `${url} (${contentType})\n\n`;
          return {
            content: [{ type: "text", text: header + content }],
            details: { ok: true, mode: "fetch", url, title, query },
          };
        }

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

        const body = {
          objective: query,
          max_results: max_results ?? DEFAULT_MAX_RESULTS,
          excerpts: {
            max_chars_per_result: max_chars_per_result ?? DEFAULT_MAX_CHARS,
          },
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
          .map(
            (result, index) =>
              `${index + 1}. ${formatResult(result, max_chars_per_result ?? DEFAULT_MAX_CHARS)}`
          )
          .join("\n\n");

        return {
          content: [{ type: "text", text: rendered || "(no results)" }],
          details: {
            ok: true,
            mode: "search",
            count: results.length,
            search_id: data.search_id ?? null,
            query,
          },
        };
      } finally {
        stopSpinner();
      }
    },

    renderCall(args, theme) {
      const query = typeof args.query === "string" ? args.query : "";
      const isFetch = isUrl(query);
      const label = isFetch ? "Web Fetch" : "Web Search";
      const preview = query ? shorten(query, 60) : "";
      const title = theme.fg("toolTitle", theme.bold(label));
      const detail = preview
        ? ` ${theme.fg("muted", "·")} ${theme.fg(isFetch ? "accent" : "muted", preview)}`
        : "";
      return new Text(`${title}${detail}`, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const details = result.details as
        | {
            mode?: "search" | "fetch";
            count?: number;
            search_id?: string | null;
            url?: string;
            title?: string | null;
            spinnerIndex?: number;
            preview?: string;
            query?: string;
            stage?: "searching" | "fetching";
          }
        | undefined;
      const content = result.content?.[0];
      const raw = content?.type === "text" ? content.text : "(no results)";

      if (isPartial) {
        const spinnerIndex = details?.spinnerIndex ?? 0;
        const spinner =
          SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length] ?? "⠋";
        const stage =
          details?.stage === "fetching" ? "Fetching…" : "Searching…";
        const text = `${theme.fg("accent", spinner)} ${theme.fg("thinkingText", stage)}`;
        return new Text(text, 0, 0);
      }

      if (details?.mode === "fetch") {
        const url = details.url || "";
        const title = details.title || "";
        if (!expanded) {
          let hostname = "";
          try {
            hostname = new URL(url).hostname.replace(/^www\./, "");
          } catch {}
          const label = title ? shorten(title, 48) : hostname;
          return new Text(
            `${theme.fg("success", "✓")} ${theme.fg("toolTitle", "Web Fetch")} ${theme.fg("accent", hostname)}${label && label !== hostname ? ` ${theme.fg("muted", label)}` : ""}`,
            0,
            0
          );
        }
        const header = `${theme.fg("success", "✓")} ${theme.fg("toolTitle", "Web Fetch ")}${theme.fg("accent", url)}`;
        const bodyPreview = shorten(
          raw.split("\n").slice(2).join("\n").trim(),
          500
        );
        return new Text(`${header}\n${theme.fg("muted", bodyPreview)}`, 0, 0);
      }

      const blocks = raw
        .split("\n\n")
        .map((block) => block.trim())
        .filter(Boolean);

      if (!expanded) {
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

      const lines = blocks.map((block) => {
        const urlLine = block.split("\n")[1];
        return urlLine
          ? formatResultLine(
              { url: urlLine, title: block.split("\n")[0] },
              theme
            )
          : block;
      });

      const header = details?.count
        ? `${theme.fg("success", "✓")} ${theme.fg("toolTitle", "Web Search ")}${theme.fg("muted", `(${details.count})`)}`
        : `${theme.fg("success", "✓")} ${theme.fg("toolTitle", "Web Search")}`;
      const rendered = [header, ...lines].join("\n");
      return new Text(rendered, 0, 0);
    },
  });
}
