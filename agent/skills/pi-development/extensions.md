# Extensions API

## Entry Point

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
export default function (pi: ExtensionAPI) { /* ... */ }
```

Loaded via jiti — TypeScript runs without compilation. Place in `~/.pi/agent/extensions/name.ts` or `~/.pi/agent/extensions/name/index.ts`.

## ExtensionAPI Methods

| Method | Description |
|---|---|
| `pi.on(event, handler)` | Subscribe to lifecycle events |
| `pi.registerTool(def)` | Register LLM-callable tool |
| `pi.registerCommand(name, opts)` | Register `/command` |
| `pi.registerShortcut(key, opts)` | Register keyboard shortcut |
| `pi.registerFlag(name, opts)` | Register CLI flag |
| `pi.registerProvider(name, config)` | Register/override model provider |
| `pi.registerMessageRenderer(type, fn)` | Custom rendering for message type |
| `pi.sendMessage(msg, opts?)` | Inject custom message |
| `pi.sendUserMessage(content, opts?)` | Send as-if user typed it |
| `pi.appendEntry(type, data?)` | Persist state (not in LLM context) |
| `pi.setSessionName(name)` | Set session display name |
| `pi.getSessionName()` | Get session display name |
| `pi.setLabel(entryId, label)` | Label an entry for /tree |
| `pi.exec(cmd, args, opts?)` | Shell command execution |
| `pi.getActiveTools()` | Current tool set |
| `pi.getAllTools()` | All registered tools |
| `pi.setActiveTools(names)` | Change active tools |
| `pi.setModel(model)` | Change model (returns false if no key) |
| `pi.getThinkingLevel()` | Current thinking level |
| `pi.setThinkingLevel(level)` | Set thinking level |
| `pi.getFlag(name)` | Read CLI flag value |
| `pi.events` | Shared event bus between extensions |

## Events

### Session Events

| Event | When | Can Return |
|---|---|---|
| `session_start` | Initial load | — |
| `session_before_switch` | `/new` or `/resume` | `{ cancel: true }` |
| `session_switch` | After switch | — |
| `session_before_fork` | `/fork` | `{ cancel: true }` or `{ skipConversationRestore: true }` |
| `session_fork` | After fork | — |
| `session_before_compact` | Before compaction | `{ cancel: true }` or `{ compaction: {...} }` |
| `session_compact` | After compaction | — |
| `session_before_tree` | `/tree` nav | `{ cancel: true }` or `{ summary: {...} }` |
| `session_tree` | After tree nav | — |
| `session_shutdown` | Exit (Ctrl+C/D) | — |

### Agent Events

| Event | When | Can Return |
|---|---|---|
| `before_agent_start` | After prompt, before loop | `{ message: {...}, systemPrompt: "..." }` |
| `agent_start` | Agent loop begins | — |
| `agent_end` | Agent loop ends | — |
| `turn_start` | Each LLM call begins | — |
| `turn_end` | Each LLM call ends | — |
| `context` | Before LLM call | `{ messages: [...] }` (modified copy) |
| `model_select` | Model changed | — |

### Tool Events

| Event | When | Can Return |
|---|---|---|
| `tool_call` | Before tool executes | `{ block: true, reason: "..." }` |
| `tool_result` | After tool executes | `{ content, details, isError }` |

### Input Events

| Event | When | Can Return |
|---|---|---|
| `input` | User input received | `{ action: "continue" }`, `{ action: "transform", text }`, `{ action: "handled" }` |
| `user_bash` | `!` or `!!` command | `{ operations }` or `{ result }` |

## ExtensionContext (ctx)

Every handler receives `ctx`:

```typescript
ctx.ui              // UI methods (setWidget, notify, confirm, select, input, editor, custom)
ctx.hasUI           // false in print/json/rpc mode
ctx.cwd             // Working directory
ctx.sessionManager  // Read-only session access
ctx.modelRegistry   // Model lookup
ctx.model           // Current model
ctx.isIdle()        // Agent idle?
ctx.abort()         // Abort streaming
ctx.hasPendingMessages()
ctx.shutdown()      // Graceful exit
ctx.getContextUsage()  // Token usage
ctx.compact(opts?)  // Trigger compaction
```

Commands get `ExtensionCommandContext` with additional: `waitForIdle()`, `newSession()`, `fork()`, `navigateTree()`.

## Tool Registration

```typescript
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";  // Required for Google compatibility

pi.registerTool({
  name: "tool_name",
  label: "Display Name",
  description: "What LLM sees",
  parameters: Type.Object({
    action: StringEnum(["list", "add"] as const),  // NOT Type.Union/Type.Literal
    text: Type.Optional(Type.String()),
  }),
  async execute(toolCallId, params, onUpdate, ctx, signal) {
    onUpdate?.({ content: [{ type: "text", text: "progress..." }], details: {} });
    if (signal?.aborted) return { content: [{ type: "text", text: "Cancelled" }] };
    return {
      content: [{ type: "text", text: "LLM sees this" }],
      details: { anything: "for rendering" },
    };
  },
  renderCall(args, theme) { return new Text("...", 0, 0); },
  renderResult(result, { expanded, isPartial }, theme) { return new Text("...", 0, 0); },
});
```

**Critical:** Use `StringEnum` not `Type.Union`/`Type.Literal` for enums — Google's API breaks otherwise.

## Message Delivery Modes

```typescript
pi.sendMessage(msg, { deliverAs, triggerTurn });
```

| Mode | Behavior |
|---|---|
| `"steer"` | Interrupts after current tool, skips remaining |
| `"followUp"` | Waits for agent to finish all tools |
| `"nextTurn"` | Queued for next user prompt, no interruption |

## State Reconstruction

Store state in tool `details`, reconstruct on `session_start`:

```typescript
pi.on("session_start", async (_event, ctx) => {
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "message" && entry.message.role === "toolResult") {
      if (entry.message.toolName === "my_tool") {
        myState = entry.message.details?.state;
      }
    }
  }
});
```
