import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { vi } from "vitest";

type HandlerMap = Map<string, Array<(...args: unknown[]) => unknown>>;

export interface MockExtensionAPI extends ExtensionAPI {
  _handlers: HandlerMap;
  _tools: Map<string, ToolDefinition>;
  _commands: Map<string, { description: string; handler: (...args: unknown[]) => unknown }>;
  _flags: Map<string, { value: unknown }>;
}

export function createMockExtensionAPI(): MockExtensionAPI {
  const handlers: HandlerMap = new Map();
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, { description: string; handler: (...args: unknown[]) => unknown }>();
  const flags = new Map<string, { value: unknown }>();

  const api: MockExtensionAPI = {
    _handlers: handlers,
    _tools: tools,
    _commands: commands,
    _flags: flags,
    on(event: string, handler: (...args: unknown[]) => unknown) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
    },
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, options: any) {
      commands.set(name, options);
    },
    registerShortcut: vi.fn(),
    registerFlag(name: string, options: any) {
      flags.set(name, { value: options.default });
    },
    getFlag(name: string) {
      return flags.get(name)?.value;
    },
    setFlag(name: string, value: unknown) {
      const flag = flags.get(name);
      if (flag) flag.value = value;
    },
    registerMessageRenderer: vi.fn(),
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as unknown as MockExtensionAPI;

  return api;
}

export function createMockContext(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
  const ui: ExtensionUIContext = {
    select: vi.fn().mockResolvedValue(undefined),
    confirm: vi.fn().mockResolvedValue(true),
    input: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn(),
    setStatus: vi.fn(),
    setWorkingMessage: vi.fn(),
    setWidget: vi.fn(),
    setFooter: vi.fn(),
    setHeader: vi.fn(),
    setTitle: vi.fn(),
    custom: vi.fn().mockResolvedValue(undefined),
    setEditorText: vi.fn(),
    getEditorText: vi.fn().mockReturnValue(""),
    editor: vi.fn().mockResolvedValue(undefined),
    setEditorComponent: vi.fn(),
    theme: {} as any,
    getAllThemes: vi.fn().mockReturnValue([]),
    getTheme: vi.fn().mockReturnValue(undefined),
    setTheme: vi.fn().mockReturnValue({ success: true }),
  };

  return {
    ui,
    hasUI: true,
    cwd: process.cwd(),
    sessionManager: {
      getEntries: vi.fn().mockReturnValue([]),
      getBranch: vi.fn().mockReturnValue([]),
    } as any,
    modelRegistry: {} as any,
    model: undefined,
    isIdle: vi.fn().mockReturnValue(true),
    abort: vi.fn(),
    hasPendingMessages: vi.fn().mockReturnValue(false),
    shutdown: vi.fn(),
    getContextUsage: vi.fn().mockReturnValue(undefined),
    compact: vi.fn(),
    ...overrides,
  };
}

export function getTextOutput(result: AgentToolResult<unknown>): string {
  return (
    result.content
      ?.filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n") || ""
  );
}

export async function executeTool(
  api: MockExtensionAPI,
  toolName: string,
  params: Record<string, unknown>,
  ctx?: Partial<ExtensionContext>,
): Promise<AgentToolResult<unknown>> {
  const tool = api._tools.get(toolName);
  if (!tool) throw new Error(`Tool "${toolName}" not registered`);
  const context = createMockContext(ctx);
  return tool.execute("test-call", params as any, undefined, context);
}
