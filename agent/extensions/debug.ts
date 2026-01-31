/**
 * Debug extension — runtime debugging via instrumented fetch() calls.
 * Based on https://github.com/MrgSub/opencode-debug
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { Type } from "@sinclair/typebox";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";

const LOG_DIR = ".pi";
const LOG_FILE = "debug.log";

let debugModeActive = false;
let activeDebugUrl: string | null = null;
let server: http.Server | null = null;
let serverPort: number | null = null;

function getLogPath(cwd: string): string {
  return path.join(cwd, LOG_DIR, LOG_FILE);
}

function ensureLogDir(cwd: string): void {
  fs.mkdirSync(path.join(cwd, LOG_DIR), { recursive: true });
}

function appendToLog(logPath: string, label: string, data?: unknown): void {
  const timestamp = new Date().toISOString();
  const line =
    data !== undefined
      ? `[${timestamp}] ${label} | ${JSON.stringify(data)}\n`
      : `[${timestamp}] ${label}\n`;
  fs.appendFileSync(logPath, line);
}

function generateFetchSnippet(
  url: string,
  label: string,
  dataExpr: string = "{}"
): string {
  return `fetch("${url}", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "${label}", data: ${dataExpr} }) }).catch(() => {});`;
}

function getDebugInstructions(debugUrl: string): string {
  return `
## Debug Mode Active

You are in DEBUG MODE. Insert fetch() calls into the codebase to capture runtime data for debugging.

### Workflow:
1. Analyze the issue — understand what to debug
2. Identify key locations — functions, handlers, code paths
3. Insert fetch calls — capture inputs, outputs, state, errors
4. Hand back to user — let them reproduce the issue
5. Read logs — use debug_read to analyze captured data

### Fetch Call Pattern:
\`\`\`javascript
${generateFetchSnippet(debugUrl, "descriptive-label", "{ variable1, variable2 }")}
\`\`\`

### Placement Guidelines:
- Function entry/exit points
- Before/after async operations
- Inside catch blocks for errors
- State changes and variable mutations
- Conditional branches to trace control flow

### Examples:
\`\`\`javascript
// Function entry
${generateFetchSnippet(debugUrl, "processOrder-entry", "{ orderId, items }")}

// After async call
${generateFetchSnippet(debugUrl, "api-call-complete", "{ response, status }")}

// In catch block
${generateFetchSnippet(debugUrl, "error-caught", "{ error: err.message, stack: err.stack }")}

// State change
${generateFetchSnippet(debugUrl, "state-updated", "{ prevState, nextState }")}
\`\`\`

### Debug URL: ${debugUrl}
`;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function findAvailablePort(preferred?: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(preferred ?? 0, "127.0.0.1", () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
    srv.on("error", () => {
      if (preferred) {
        const fallback = net.createServer();
        fallback.listen(0, "127.0.0.1", () => {
          const addr = fallback.address() as net.AddressInfo;
          fallback.close(() => resolve(addr.port));
        });
        fallback.on("error", reject);
      } else {
        reject(new Error("Could not find available port"));
      }
    });
  });
}

function createDebugServer(
  port: number,
  logPath: string
): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      if (req.method === "OPTIONS") {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
      }

      if (req.url === "/health" && req.method === "GET") {
        res.writeHead(200, {
          "Content-Type": "application/json",
          ...CORS_HEADERS,
        });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }

      if (req.url === "/debug" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          try {
            const parsed = JSON.parse(body);
            if (!parsed.label) {
              res.writeHead(400, CORS_HEADERS);
              res.end("Missing required field: label");
              return;
            }
            appendToLog(logPath, parsed.label, parsed.data);
            res.writeHead(200, {
              "Content-Type": "application/json",
              ...CORS_HEADERS,
            });
            res.end(JSON.stringify({ received: true }));
          } catch {
            res.writeHead(400, CORS_HEADERS);
            res.end("Invalid JSON");
          }
        });
        return;
      }

      res.writeHead(404, CORS_HEADERS);
      res.end("Not found");
    });

    srv.listen(port, "127.0.0.1", () => resolve(srv));
    srv.on("error", reject);
  });
}

function stopServer(): Promise<void> {
  return new Promise((resolve) => {
    if (server) {
      server.close(() => {
        server = null;
        serverPort = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (_event) => {
    if (debugModeActive && activeDebugUrl) {
      return { systemPrompt: getDebugInstructions(activeDebugUrl) };
    }
  });

  pi.on("session_shutdown", async () => {
    await stopServer();
    debugModeActive = false;
    activeDebugUrl = null;
  });

  pi.registerTool({
    name: "debug_start",
    label: "Debug Start",
    description: `Start debug mode to capture runtime data from the codebase.

WORKFLOW:
1. Call this tool to start the debug server
2. Insert fetch() calls at strategic locations in the code to capture runtime data
3. Ask the user to reproduce the issue
4. Use debug_read to analyze the captured logs and identify the problem

This enables runtime debugging by capturing labeled data points as the code executes.`,
    parameters: Type.Object({
      port: Type.Optional(
        Type.Number({
          description: "Port for local server (default: auto-select)",
        })
      ),
    }),
    async execute(_toolCallId, params, _onUpdate, ctx) {
      if (server && serverPort) {
        const url = `http://localhost:${serverPort}/debug`;
        return {
          content: [
            {
              type: "text",
              text: `Debug server already running!\n\nDebug URL: ${url}\n\n**Next Step:** Insert fetch() calls in the code where you need to capture data, then ask the user to reproduce the issue.`,
            },
          ],
          details: { active: true, url },
        };
      }

      const logPath = getLogPath(ctx.cwd);
      ensureLogDir(ctx.cwd);

      const port = await findAvailablePort(params.port);
      server = await createDebugServer(port, logPath);
      serverPort = port;

      const url = `http://localhost:${port}/debug`;
      debugModeActive = true;
      activeDebugUrl = url;

      const instructions = [
        "# Debug Mode Started\n",
        `**Debug URL:** ${url}`,
        `**Log File:** ${LOG_DIR}/${LOG_FILE}`,
        "",
        "## Next Steps:",
        "1. **Instrument the code** — Insert fetch() calls at key locations",
        "2. **Hand back to user** — Ask them to reproduce the issue",
        "3. **Read logs** — Use debug_read to analyze captured data",
        "",
        "## Fetch Call Template:",
        "```javascript",
        generateFetchSnippet(url, "label-here", "{ key: value }"),
        "```",
        "",
        "## Placement Guidelines:",
        "- Function entry/exit points",
        "- Before/after async operations",
        "- Inside catch blocks for errors",
        "- State changes and variable mutations",
        "- Conditional branches to trace control flow",
        "",
        "Use descriptive labels like 'handleSubmit-entry', 'api-response', 'error-caught'",
      ].join("\n");

      return {
        content: [{ type: "text", text: instructions }],
        details: { active: true, url, port },
      };
    },
    renderResult(result, _opts, theme) {
      const { Text } = require("@mariozechner/pi-tui");
      const details = result.details as
        | { active?: boolean; url?: string; port?: number }
        | undefined;
      if (details?.active) {
        return new Text(
          `${theme.fg("success", "●")} Debug server running at ${theme.fg("accent", details.url!)}`,
          0,
          0
        );
      }
      return new Text(theme.fg("muted", "Debug server stopped"), 0, 0);
    },
  });

  pi.registerTool({
    name: "debug_stop",
    label: "Debug Stop",
    description: `Stop debug mode and preserve the captured logs.

Call this after debugging is complete. The log file is preserved so you can still read it with debug_read.
Remember to remove the fetch() calls you inserted in the codebase.`,
    parameters: Type.Object({}),
    async execute() {
      if (!server) {
        return {
          content: [{ type: "text", text: "Debug server is not running." }],
          details: { wasRunning: false },
        };
      }

      await stopServer();
      debugModeActive = false;
      activeDebugUrl = null;

      const text = [
        "# Debug Mode Stopped",
        "",
        `Log file preserved at: ${LOG_DIR}/${LOG_FILE}`,
        "",
        "**Remember:** Remove the fetch() debug calls you inserted in the codebase.",
      ].join("\n");

      return {
        content: [{ type: "text", text }],
        details: { wasRunning: true },
      };
    },
    renderResult(result, _opts, theme) {
      const { Text } = require("@mariozechner/pi-tui");
      const details = result.details as { wasRunning?: boolean } | undefined;
      if (details?.wasRunning) {
        return new Text(
          `${theme.fg("warning", "●")} Debug server stopped — log preserved at ${theme.fg("dim", `${LOG_DIR}/${LOG_FILE}`)}`,
          0,
          0
        );
      }
      return new Text(theme.fg("muted", "Debug server was not running"), 0, 0);
    },
  });

  pi.registerTool({
    name: "debug_read",
    label: "Debug Read",
    description: `Read the debug log to analyze captured runtime data.

Use this after the user has reproduced the issue to see what data was captured by the fetch() calls.
The logs show timestamped entries with labels and data payloads.

Analyze the captured data to:
- Trace the execution flow
- Identify unexpected values
- Find where errors occur
- Compare expected vs actual behavior`,
    parameters: Type.Object({
      tail: Type.Optional(
        Type.Number({
          description: "Only show last N lines (useful for large logs)",
        })
      ),
    }),
    async execute(_toolCallId, params, _onUpdate, ctx) {
      const logPath = getLogPath(ctx.cwd);

      if (!fs.existsSync(logPath)) {
        return {
          content: [
            {
              type: "text",
              text: "No debug log yet.\n\n**Tip:** Make sure fetch() calls are in place and the user has reproduced the issue.",
            },
          ],
          details: { entries: 0 },
        };
      }

      const content = fs.readFileSync(logPath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);

      if (lines.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "Debug log is empty.\n\n**Tip:** The instrumented code paths may not have been executed. Ask the user to reproduce the issue.",
            },
          ],
          details: { entries: 0 },
        };
      }

      const output =
        params.tail && params.tail > 0 ? lines.slice(-params.tail) : lines;

      const text = [
        `# Debug Log (${output.length} entries)`,
        "=".repeat(50),
        "",
        output.join("\n"),
        "",
        "=".repeat(50),
        "**Analyze the above data to identify the issue.**",
      ].join("\n");

      return {
        content: [{ type: "text", text }],
        details: { entries: output.length, total: lines.length },
      };
    },
    renderResult(result, _opts, theme) {
      const { Text } = require("@mariozechner/pi-tui");
      const details = result.details as
        | { entries?: number; total?: number }
        | undefined;
      if (details?.entries) {
        const suffix =
          details.total && details.total > details.entries
            ? ` (showing ${details.entries} of ${details.total})`
            : "";
        return new Text(
          `${theme.fg("accent", "📋")} ${details.entries} debug entries${suffix}`,
          0,
          0
        );
      }
      return new Text(theme.fg("muted", "No debug entries"), 0, 0);
    },
  });

  pi.registerTool({
    name: "debug_clear",
    label: "Debug Clear",
    description: `Clear the debug log file to start fresh.

Use this before a new debugging session to remove old log entries.`,
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _onUpdate, ctx) {
      const logPath = getLogPath(ctx.cwd);

      if (fs.existsSync(logPath)) {
        fs.writeFileSync(logPath, "");
        return {
          content: [
            {
              type: "text",
              text: `Debug log cleared: ${LOG_DIR}/${LOG_FILE}\n\nReady for fresh debug data.`,
            },
          ],
          details: { cleared: true },
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Debug log does not exist yet: ${LOG_DIR}/${LOG_FILE}`,
          },
        ],
        details: { cleared: false },
      };
    },
    renderResult(result, _opts, theme) {
      const { Text } = require("@mariozechner/pi-tui");
      const details = result.details as { cleared?: boolean } | undefined;
      if (details?.cleared) {
        return new Text(`${theme.fg("success", "✓")} Debug log cleared`, 0, 0);
      }
      return new Text(theme.fg("muted", "No debug log to clear"), 0, 0);
    },
  });

  pi.registerTool({
    name: "debug_status",
    label: "Debug Status",
    description:
      "Check if debug mode is currently active and get the debug URL.",
    parameters: Type.Object({}),
    async execute(
      _toolCallId,
      _params,
      _onUpdate,
      _ctx,
      _signal
    ) {
      if (!server || !debugModeActive) {
        const details: { active: boolean; url?: string } = { active: false };
        return {
          content: [
            {
              type: "text",
              text: "Debug mode is **not active**.\n\nUse debug_start to begin a debugging session.",
            },
          ],
          details,
        };
      }

      const url = `http://localhost:${serverPort}/debug`;
      const text = [
        "# Debug Mode Active",
        "",
        `**Debug URL:** ${url}`,
        `**Log File:** ${LOG_DIR}/${LOG_FILE}`,
        "",
        "Use this URL in your fetch() calls to capture debug data.",
      ].join("\n");

      const details: { active: boolean; url?: string } = { active: true, url };
      return {
        content: [{ type: "text", text }],
        details,
      };
    },
    renderResult(result, _opts, theme) {
      const { Text } = require("@mariozechner/pi-tui");
      const details = result.details as
        | { active?: boolean; url?: string }
        | undefined;
      if (details?.active) {
        return new Text(
          `${theme.fg("success", "●")} Active — ${theme.fg("accent", details.url!)}`,
          0,
          0
        );
      }
      return new Text(`${theme.fg("muted", "●")} Not active`, 0, 0);
    },
  });

  pi.registerCommand("debug", {
    description: "Check debug mode status",
    handler: async (_args, ctx) => {
      if (!debugModeActive || !server) {
        ctx.ui.notify(
          "Debug mode is not active. Ask the agent to use debug_start.",
          "info"
        );
      } else {
        ctx.ui.notify(`Debug active on port ${serverPort}`, "info");
      }
    },
  });
}
