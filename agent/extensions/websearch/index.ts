/**
 * Parallel Search + URL extraction tool.
 *
 * - Search mode: Parallel Search API (primary)
 * - URL mode: Parallel Extract API (primary) with Gemini fallback
 */

import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";

import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import {
  createSpinnerTicker,
  getSpinnerFrame,
  resolveApiKey,
  resolveSettingString,
  SETTINGS_PATH,
} from "../shared/web-infra.js";

const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_MAX_CHARS = 1500;
const PARALLEL_SEARCH_API_URL = "https://api.parallel.ai/v1beta/search";
const PARALLEL_EXTRACT_API_URL = "https://api.parallel.ai/v1beta/extract";
const PARALLEL_BETA_HEADER = "search-extract-2025-10-10";
const GEMINI_MODEL = "gemini-3-flash";
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const MAX_INLINE_CONTENT = 30_000;
const GEMINI_TIMEOUT_MS = 60_000;

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

type ExtractResult = {
  url: string;
  title?: string | null;
  excerpts?: string[] | null;
  full_content?: string | null;
};

type ExtractError = {
  url?: string;
  error_type?: string;
  http_status_code?: number;
  content?: string;
};

type ExtractResponse = {
  extract_id?: string;
  results?: ExtractResult[];
  errors?: ExtractError[];
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

type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
};

type ExtractSuccess = {
  ok: true;
  title: string | null;
  content: string;
  responseId: string | null;
};

type ExtractFailure = {
  ok: false;
  status?: number;
  recoverable: boolean;
  message: string;
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

function formatResultLine(result: SearchResult, theme: Theme): string {
  const title = result.title?.trim() || "";
  const desc = title ? shorten(title, 48) : "";
  const parts = [
    theme.fg("success", "✓"),
    " ",
    theme.fg("toolTitle", "% "),
    theme.fg("accent", result.url),
  ];
  if (desc) parts.push(" ", theme.fg("muted", desc));
  return parts.join("");
}

function isUrl(text: string): boolean {
  const trimmed = text.trim();
  return /^https?:\/\/\S+$/i.test(trimmed);
}

function getParallelApiKey(): string | null {
  return resolveApiKey("websearch", "PARALLEL_API_KEY");
}

function getGeminiApiKey(): string | null {
  return resolveSettingString("websearch", "geminiApiKey", "GEMINI_API_KEY");
}

function readErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function truncateContent(content: string): {
  text: string;
  truncated: boolean;
} {
  if (content.length <= MAX_INLINE_CONTENT) {
    return { text: content, truncated: false };
  }

  return {
    text:
      content.slice(0, MAX_INLINE_CONTENT) +
      "\n\n[Content truncated to 30,000 characters.]",
    truncated: true,
  };
}

function isRecoverableStatus(status: number | undefined): boolean {
  if (status === undefined) return true;
  return (
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    status >= 500
  );
}

function isRecoverableParallelExtractFailure(error: ExtractError): boolean {
  return isRecoverableStatus(error.http_status_code);
}

function extractHeadingTitle(text: string): string | null {
  const match = text.match(/^#{1,2}\s+(.+)/m);
  if (!match) return null;
  const cleaned = match[1].replace(/\*+/g, "").trim();
  return cleaned || null;
}

async function searchWithParallel(
  apiKey: string,
  query: string,
  maxResults: number,
  maxCharsPerResult: number,
  signal?: AbortSignal
): Promise<
  | { ok: true; data: SearchResponse }
  | { ok: false; status?: number; message: string }
> {
  const body = {
    objective: query,
    max_results: maxResults,
    excerpts: {
      max_chars_per_result: maxCharsPerResult,
    },
  };

  let response: Response;
  try {
    response = await fetch(PARALLEL_SEARCH_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "parallel-beta": PARALLEL_BETA_HEADER,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err: unknown) {
    return {
      ok: false,
      message: `Parallel search failed: ${readErrorMessage(err)}`,
    };
  }

  if (!response.ok) {
    const text = await response.text();
    return {
      ok: false,
      status: response.status,
      message: `Parallel Search API error (${response.status}): ${text}`,
    };
  }

  try {
    const data = (await response.json()) as SearchResponse;
    return { ok: true, data };
  } catch {
    return {
      ok: false,
      status: response.status,
      message: "Parallel Search API returned invalid JSON",
    };
  }
}

async function extractWithParallel(
  apiKey: string,
  url: string,
  signal?: AbortSignal
): Promise<ExtractSuccess | ExtractFailure> {
  const body = {
    urls: [url],
    full_content: true,
    excerpts: true,
  };

  let response: Response;
  try {
    response = await fetch(PARALLEL_EXTRACT_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "parallel-beta": PARALLEL_BETA_HEADER,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err: unknown) {
    return {
      ok: false,
      recoverable: true,
      message: `Parallel extract failed: ${readErrorMessage(err)}`,
    };
  }

  if (!response.ok) {
    const text = await response.text();
    return {
      ok: false,
      status: response.status,
      recoverable: isRecoverableStatus(response.status),
      message: `Parallel Extract API error (${response.status}): ${text}`,
    };
  }

  let data: ExtractResponse;
  try {
    data = (await response.json()) as ExtractResponse;
  } catch {
    return {
      ok: false,
      status: response.status,
      recoverable: true,
      message: "Parallel Extract API returned invalid JSON",
    };
  }

  const results = data.results ?? [];
  const primaryResult = results.find((item) => item.url === url) ?? results[0];
  const fullContent = primaryResult?.full_content?.trim();
  const excerptContent =
    primaryResult?.excerpts
      ?.map((item) => item.trim())
      .filter(Boolean)
      .join("\n\n") ?? "";

  const content = fullContent || excerptContent;
  if (content) {
    return {
      ok: true,
      title: primaryResult?.title?.trim() || null,
      content,
      responseId: data.extract_id ?? null,
    };
  }

  const firstError =
    (data.errors ?? []).find((item) => item.url === url) ?? data.errors?.[0];
  if (firstError) {
    const message =
      firstError.content?.trim() ||
      firstError.error_type?.trim() ||
      "Parallel Extract returned no content";

    return {
      ok: false,
      status: firstError.http_status_code,
      recoverable: isRecoverableParallelExtractFailure(firstError),
      message,
    };
  }

  return {
    ok: false,
    recoverable: true,
    message: "Parallel Extract returned no usable content.",
  };
}

async function extractWithGemini(
  url: string,
  apiKey: string,
  signal?: AbortSignal
): Promise<ExtractSuccess | ExtractFailure> {
  const prompt =
    "Extract the complete readable content from this URL as clean markdown. " +
    "Include title, body text, code blocks, and tables. Do not summarize.\n\n" +
    `URL: ${url}`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    tools: [{ url_context: {} }],
  };

  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(GEMINI_TIMEOUT_MS)])
    : AbortSignal.timeout(GEMINI_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(
      `${GEMINI_API_BASE}/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: requestSignal,
      }
    );
  } catch (err: unknown) {
    return {
      ok: false,
      recoverable: false,
      message: `Gemini fallback failed: ${readErrorMessage(err)}`,
    };
  }

  if (!response.ok) {
    const text = await response.text();
    return {
      ok: false,
      status: response.status,
      recoverable: false,
      message: `Gemini fallback error (${response.status}): ${text}`,
    };
  }

  let data: GeminiResponse;
  try {
    data = (await response.json()) as GeminiResponse;
  } catch {
    return {
      ok: false,
      status: response.status,
      recoverable: false,
      message: "Gemini fallback returned invalid JSON",
    };
  }

  const content =
    data.candidates?.[0]?.content?.parts
      ?.map((part) => part.text)
      .filter(
        (part): part is string =>
          typeof part === "string" && part.trim().length > 0
      )
      .join("\n") ?? "";

  if (!content.trim()) {
    return {
      ok: false,
      recoverable: false,
      message: "Gemini fallback returned empty content",
    };
  }

  return {
    ok: true,
    title: extractHeadingTitle(content),
    content,
    responseId: null,
  };
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

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const { query, max_results, max_chars_per_result } =
        params as SearchParams;
      const directUrl = isUrl(query);
      const preview = shorten(query, 80);
      const canAnimate = !!onUpdate && ctx.hasUI;
      const spinnerStage: SpinnerDetails["stage"] = directUrl
        ? "fetching"
        : "searching";

      const stopSpinner = createSpinnerTicker(
        canAnimate,
        (spinnerIndex) => {
          onUpdate?.({
            content: [
              {
                type: "text",
                text: spinnerStage === "fetching" ? "Fetching…" : "Searching…",
              },
            ],
            details: {
              stage: spinnerStage,
              spinnerIndex,
              query,
              preview,
            } as SpinnerDetails,
          });
        },
        signal
      );

      try {
        const parallelApiKey = getParallelApiKey();
        if (!parallelApiKey) {
          return {
            content: [
              {
                type: "text",
                text:
                  `Missing API key. Set PARALLEL_API_KEY or ${SETTINGS_PATH} ` +
                  "under websearch.apiKey to use websearch.",
              },
            ],
            details: { ok: false },
            isError: true,
          };
        }

        if (directUrl) {
          const url = query.trim();
          const startedAt = Date.now();

          const parallelExtract = await extractWithParallel(
            parallelApiKey,
            url,
            signal
          );

          if (parallelExtract.ok) {
            const truncated = truncateContent(parallelExtract.content);
            const header = parallelExtract.title
              ? `${parallelExtract.title}\n${url}\n\n`
              : `${url}\n\n`;

            return {
              content: [{ type: "text", text: header + truncated.text }],
              details: {
                ok: true,
                mode: "fetch",
                provider: "parallel-extract",
                fallbackUsed: false,
                degraded: false,
                url,
                title: parallelExtract.title,
                query,
                extract_id: parallelExtract.responseId,
                truncated: truncated.truncated,
                latencyMs: Date.now() - startedAt,
              },
            };
          }

          const geminiApiKey = getGeminiApiKey();
          if (parallelExtract.recoverable && geminiApiKey) {
            const geminiExtract = await extractWithGemini(
              url,
              geminiApiKey,
              signal
            );

            if (geminiExtract.ok) {
              const truncated = truncateContent(geminiExtract.content);
              const header = geminiExtract.title
                ? `${geminiExtract.title}\n${url}\n\n`
                : `${url}\n\n`;

              return {
                content: [{ type: "text", text: header + truncated.text }],
                details: {
                  ok: true,
                  mode: "fetch",
                  provider: "gemini-3-flash",
                  fallbackUsed: true,
                  degraded: true,
                  fallbackReason: parallelExtract.message,
                  url,
                  title: geminiExtract.title,
                  query,
                  truncated: truncated.truncated,
                  latencyMs: Date.now() - startedAt,
                },
              };
            }

            return {
              content: [
                {
                  type: "text",
                  text:
                    `Parallel extract failed: ${parallelExtract.message}\n` +
                    `Gemini fallback failed: ${geminiExtract.message}`,
                },
              ],
              details: {
                ok: false,
                mode: "fetch",
                provider: "parallel-extract",
                fallbackUsed: true,
                degraded: true,
                error: geminiExtract.message,
                fallbackReason: parallelExtract.message,
                query,
                latencyMs: Date.now() - startedAt,
              },
              isError: true,
            };
          }

          return {
            content: [
              {
                type: "text",
                text: `Parallel extract failed: ${parallelExtract.message}`,
              },
            ],
            details: {
              ok: false,
              mode: "fetch",
              provider: "parallel-extract",
              fallbackUsed: false,
              degraded: false,
              error: parallelExtract.message,
              query,
              latencyMs: Date.now() - startedAt,
            },
            isError: true,
          };
        }

        const startedAt = Date.now();
        const maxResults = max_results ?? DEFAULT_MAX_RESULTS;
        const maxChars = max_chars_per_result ?? DEFAULT_MAX_CHARS;

        const parallelSearch = await searchWithParallel(
          parallelApiKey,
          query,
          maxResults,
          maxChars,
          signal
        );

        if (!parallelSearch.ok) {
          return {
            content: [{ type: "text", text: parallelSearch.message }],
            details: {
              ok: false,
              mode: "search",
              provider: "parallel-search",
              error: parallelSearch.message,
              status: parallelSearch.status,
              query,
              latencyMs: Date.now() - startedAt,
            },
            isError: true,
          };
        }

        const results = parallelSearch.data.results ?? [];
        const rendered = results
          .map(
            (result, index) => `${index + 1}. ${formatResult(result, maxChars)}`
          )
          .join("\n\n");

        return {
          content: [{ type: "text", text: rendered || "(no results)" }],
          details: {
            ok: true,
            mode: "search",
            provider: "parallel-search",
            fallbackUsed: false,
            degraded: false,
            count: results.length,
            search_id: parallelSearch.data.search_id ?? null,
            query,
            latencyMs: Date.now() - startedAt,
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
            extract_id?: string | null;
            url?: string;
            title?: string | null;
            spinnerIndex?: number;
            query?: string;
            stage?: "searching" | "fetching";
            provider?: string;
            fallbackUsed?: boolean;
            fallbackReason?: string;
            degraded?: boolean;
            latencyMs?: number;
            truncated?: boolean;
          }
        | undefined;
      const content = result.content?.[0];
      const raw = content?.type === "text" ? content.text : "(no results)";

      if (isPartial) {
        const spinner = getSpinnerFrame(details?.spinnerIndex ?? 0);
        const stage =
          details?.stage === "fetching" ? "Fetching…" : "Searching…";
        const text = `${theme.fg("accent", spinner)} ${theme.fg("thinkingText", stage)}`;
        return new Text(text, 0, 0);
      }

      if (details?.mode === "fetch") {
        const url = details.url || details.query || "";
        const title = details.title || "";
        const provider = details.provider ?? "parallel-extract";
        const providerLabel =
          provider === "gemini-3-flash" ? "gemini" : "parallel";
        const fallback = details.fallbackUsed ? " fallback" : "";
        const degraded = details.degraded ? " degraded" : "";
        const meta = ` [${providerLabel}${fallback}${degraded}]`;

        if (!expanded) {
          let hostname = "";
          try {
            hostname = new URL(url).hostname.replace(/^www\./, "");
          } catch {}
          const label = title ? shorten(title, 48) : hostname;
          const truncated = details.truncated ? " [truncated]" : "";
          return new Text(
            `${theme.fg("success", "✓")} ${theme.fg("toolTitle", "% Web Fetch")} ${theme.fg("accent", hostname)}${label && label !== hostname ? ` ${theme.fg("muted", label)}` : ""}${theme.fg("dim", meta)}${theme.fg("dim", truncated)}`,
            0,
            0
          );
        }

        const latency =
          typeof details.latencyMs === "number"
            ? theme.fg("dim", ` (${details.latencyMs}ms)`)
            : "";
        const header =
          `${theme.fg("success", "✓")} ${theme.fg("toolTitle", "% Web Fetch ")}` +
          `${theme.fg("accent", url)}${theme.fg("dim", meta)}${latency}`;

        const lines = [header, theme.fg("muted", shorten(raw, 1200))];
        if (details.fallbackReason) {
          lines.push(
            theme.fg(
              "warning",
              `Fallback reason: ${shorten(details.fallbackReason, 180)}`
            )
          );
        }
        return new Text(lines.join("\n"), 0, 0);
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
            const urlLine = lines.find((line) => line.startsWith("http"));
            if (!urlLine) return null;
            try {
              return new URL(urlLine).hostname.replace(/^www\./, "");
            } catch {
              return null;
            }
          })
          .filter(Boolean);
        const uniqueHosts = [...new Set(urls)].slice(0, 4);
        let text = `${theme.fg("success", "✓")} ${theme.fg("muted", `◈ ${count} results`)}`;
        if (uniqueHosts.length > 0) {
          text += theme.fg("dim", ` · ${uniqueHosts.join(", ")}`);
        }
        if (details?.provider) {
          text += theme.fg("dim", ` · ${details.provider}`);
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

      const provider = details?.provider
        ? theme.fg("dim", ` · ${details.provider}`)
        : "";
      const header = details?.count
        ? `${theme.fg("success", "✓")} ${theme.fg("toolTitle", "◈ Web Search ")}${theme.fg("muted", `(${details.count})`)}${provider}`
        : `${theme.fg("success", "✓")} ${theme.fg("toolTitle", "◈ Web Search")}${provider}`;
      const rendered = [header, ...lines].join("\n");
      return new Text(rendered, 0, 0);
    },
  });
}
