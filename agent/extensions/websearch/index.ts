/**
 * Parallel Search + URL extraction tool powered by parallel-cli.
 */

import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";

import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createSpinnerTicker, getSpinnerFrame } from "../shared/web-infra.js";

const execFileAsync = promisify(execFile);

const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_MAX_CHARS = 1500;
const MAX_INLINE_CONTENT = 30_000;
const PARALLEL_CLI_COMMAND = "parallel-cli";
const EXEC_MAX_BUFFER = 10 * 1024 * 1024;

type SearchResult = {
  url: string;
  title?: string | null;
  publish_date?: string | null;
  excerpts?: string[] | null;
};

type SearchResponse = {
  status?: string;
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
  status?: string;
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

type ExtractSuccess = {
  ok: true;
  title: string | null;
  content: string;
  responseId: string | null;
};

type ExtractFailure = {
  ok: false;
  status?: number;
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

async function runParallelCli(
  args: string[],
  signal?: AbortSignal
): Promise<
  | {
      ok: true;
      stdout: string;
      stderr: string;
    }
  | {
      ok: false;
      status?: number;
      message: string;
      stderr?: string;
    }
> {
  try {
    const { stdout, stderr } = await execFileAsync(PARALLEL_CLI_COMMAND, args, {
      encoding: "utf8",
      maxBuffer: EXEC_MAX_BUFFER,
      signal,
    });

    return {
      ok: true,
      stdout,
      stderr,
    };
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException & {
      code?: string | number;
      stdout?: string;
      stderr?: string;
    };

    if (signal?.aborted) {
      return {
        ok: false,
        message: "Parallel CLI request was aborted.",
      };
    }

    if (error.code === "ENOENT") {
      return {
        ok: false,
        message:
          "parallel-cli is not installed or not in PATH. Install it, then run `parallel-cli login`.",
      };
    }

    const errorCode = (error as { code?: unknown }).code;
    const status = typeof errorCode === "number" ? errorCode : undefined;
    const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
    const stdout = typeof error.stdout === "string" ? error.stdout.trim() : "";
    const detail = stderr || stdout || readErrorMessage(err);

    return {
      ok: false,
      status,
      message:
        `parallel-cli ${args[0] ?? "command"} failed` +
        (status !== undefined ? ` (${status})` : "") +
        `: ${detail}`,
      stderr,
    };
  }
}

async function runParallelCliJson<T>(
  args: string[],
  signal?: AbortSignal
): Promise<
  | {
      ok: true;
      data: T;
    }
  | {
      ok: false;
      status?: number;
      message: string;
      stderr?: string;
    }
> {
  const result = await runParallelCli(args, signal);
  if (!result.ok) return result;

  const raw = result.stdout.trim();
  if (!raw) {
    return {
      ok: false,
      message: `parallel-cli ${args[0] ?? "command"} returned empty output`,
      stderr: result.stderr.trim(),
    };
  }

  try {
    const data = JSON.parse(raw) as T;
    return {
      ok: true,
      data,
    };
  } catch {
    return {
      ok: false,
      message: `parallel-cli ${args[0] ?? "command"} returned invalid JSON`,
      stderr: result.stderr.trim(),
    };
  }
}

async function ensureParallelCliReady(signal?: AbortSignal): Promise<
  | {
      ok: true;
    }
  | {
      ok: false;
      message: string;
    }
> {
  const versionResult = await runParallelCli(["--version"], signal);
  if (!versionResult.ok) {
    return {
      ok: false,
      message: versionResult.message,
    };
  }

  const authResult = await runParallelCli(["auth"], signal);
  if (!authResult.ok) {
    const authMessage = authResult.message.toLowerCase();
    if (
      authMessage.includes("not authenticated") ||
      authMessage.includes("unauthorized") ||
      authMessage.includes("login")
    ) {
      return {
        ok: false,
        message: "parallel-cli is not authenticated. Run `parallel-cli login`.",
      };
    }

    return {
      ok: false,
      message: authResult.message,
    };
  }

  const authText = `${authResult.stdout}\n${authResult.stderr}`.toLowerCase();
  if (authText.includes("not authenticated")) {
    return {
      ok: false,
      message: "parallel-cli is not authenticated. Run `parallel-cli login`.",
    };
  }

  return { ok: true };
}

async function searchWithParallelCli(
  query: string,
  maxResults: number,
  maxCharsPerResult: number,
  signal?: AbortSignal
): Promise<
  | { ok: true; data: SearchResponse }
  | { ok: false; status?: number; message: string }
> {
  const response = await runParallelCliJson<SearchResponse>(
    [
      "search",
      query,
      "--mode",
      "one-shot",
      "--max-results",
      String(maxResults),
      "--excerpt-max-chars-per-result",
      String(maxCharsPerResult),
      "--json",
    ],
    signal
  );

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message: response.message,
    };
  }

  if (response.data.status && response.data.status !== "ok") {
    return {
      ok: false,
      message: `parallel-cli search returned status "${response.data.status}"`,
    };
  }

  return { ok: true, data: response.data };
}

async function extractWithParallelCli(
  url: string,
  signal?: AbortSignal
): Promise<ExtractSuccess | ExtractFailure> {
  const response = await runParallelCliJson<ExtractResponse>(
    ["fetch", url, "--full-content", "--json"],
    signal
  );

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message: response.message,
    };
  }

  if (response.data.status && response.data.status !== "ok") {
    return {
      ok: false,
      message: `parallel-cli fetch returned status "${response.data.status}"`,
    };
  }

  const results = response.data.results ?? [];
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
      responseId: response.data.extract_id ?? null,
    };
  }

  const firstError =
    (response.data.errors ?? []).find((item) => item.url === url) ??
    response.data.errors?.[0];
  if (firstError) {
    const message =
      firstError.content?.trim() ||
      firstError.error_type?.trim() ||
      "parallel-cli fetch returned no content";

    return {
      ok: false,
      status: firstError.http_status_code,
      message,
    };
  }

  return {
    ok: false,
    message: "parallel-cli fetch returned no usable content",
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
        const ready = await ensureParallelCliReady(signal);
        if (!ready.ok) {
          return {
            content: [{ type: "text", text: ready.message }],
            details: { ok: false },
            isError: true,
          };
        }

        if (directUrl) {
          const url = query.trim();
          const startedAt = Date.now();

          const parallelExtract = await extractWithParallelCli(url, signal);

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
                provider: "parallel-cli-fetch",
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

          return {
            content: [
              {
                type: "text",
                text: `Parallel fetch failed: ${parallelExtract.message}`,
              },
            ],
            details: {
              ok: false,
              mode: "fetch",
              provider: "parallel-cli-fetch",
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

        const parallelSearch = await searchWithParallelCli(
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
              provider: "parallel-cli-search",
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
            provider: "parallel-cli-search",
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
        const provider = details.provider ?? "parallel-cli-fetch";
        const providerLabel = provider.startsWith("parallel-cli")
          ? "parallel-cli"
          : provider;
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
