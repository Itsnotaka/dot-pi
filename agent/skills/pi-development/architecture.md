# Pi Architecture

## Package Structure

```
dist/
├── main.js              # Entry point, bootstraps modes
├── cli.js               # Argument parsing (commander)
├── cli/args.js          # Flag definitions
├── config.js            # Settings loading, defaults
├── migrations.js        # Session format migrations
├── index.js             # Public API exports
├── core/
│   ├── agent-session.js     # AgentSession - orchestrates model, tools, extensions
│   ├── system-prompt.js     # System prompt builder
│   ├── settings-manager.js  # Settings CRUD
│   ├── resource-loader.js   # Discovers extensions, skills, prompts, themes
│   ├── skills.js            # Skill loading and validation
│   ├── prompt-templates.js  # Prompt template loading
│   ├── package-manager.js   # npm/git package installation
│   ├── sdk.js               # Embeddable SDK (PiSDK class)
│   ├── session/
│   │   └── session-manager.js  # Session storage, branching, entries
│   ├── extensions/
│   │   └── runner.js        # Extension lifecycle, event dispatch
│   ├── tools/
│   │   ├── read.ts          # ReadToolDetails
│   │   ├── bash.ts          # BashToolDetails
│   │   ├── edit.ts          # EditToolDetails
│   │   ├── write.ts         # WriteToolDetails
│   │   ├── grep.ts          # GrepToolDetails
│   │   ├── find.ts          # FindToolDetails
│   │   └── ls.ts            # LsToolDetails
│   ├── compaction/
│   │   ├── compaction.js    # Auto/manual compaction
│   │   ├── branch-summarization.js
│   │   └── utils.js
│   └── export-html/
│       └── index.js         # HTML export
├── modes/
│   ├── interactive/
│   │   ├── interactive-mode.js  # Full TUI mode
│   │   └── components/
│   │       ├── tool-execution.js   # Built-in tool rendering
│   │       ├── config-selector.js  # Model/config picker
│   │       └── login-dialog.js     # OAuth login
│   ├── rpc/
│   │   └── rpc-mode.js     # JSON-RPC over stdio
│   └── json/                # Streaming JSON events to stdout
└── utils/                   # Truncation, formatting, paths
```

## Modes

Pi runs in one of three modes:

| Mode        | Flag          | Description                                       |
| ----------- | ------------- | ------------------------------------------------- |
| Interactive | (default)     | Full TUI with editor, chat, streaming             |
| Print       | `-p`          | One-shot: prompt in, text out, exit               |
| JSON        | `--mode json` | Streams JSON events to stdout (used by subagents) |
| RPC         | `--mode rpc`  | JSON-RPC over stdio for embedding                 |

## Agent Loop

```
User prompt
  → before_agent_start event (can inject message, modify system prompt)
  → agent_start event
  → Turn loop:
      → turn_start event
      → context event (can modify messages)
      → LLM call (streaming)
      → For each tool call in response:
          → tool_call event (can block)
          → Tool executes
          → tool_result event (can modify result)
      → turn_end event
      → If LLM wants more tools → next turn
  → agent_end event
```

## Tool Result Shape

Every tool returns:

```typescript
{
  content: ContentPart[];     // Sent to LLM (text, images)
  details?: Record<string, any>;  // For rendering, state tracking
  isError?: boolean;
}
```

`content` is what the model sees. `details` is for TUI rendering and session
state reconstruction. Built-in tools have typed details (e.g., `BashToolDetails`
with `exitCode`, `command`, `cwd`).

## Output Truncation

Tools MUST truncate output. Built-in limit: 50KB / 2000 lines (whichever first).

```typescript
import {
  truncateHead,
  truncateTail,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "@mariozechner/pi-coding-agent";
```

- `truncateHead` — keep beginning (file reads, search results)
- `truncateTail` — keep end (logs, command output)

## Extension Loading

Extensions discovered from:

1. `~/.pi/agent/extensions/*.ts` (single file)
2. `~/.pi/agent/extensions/*/index.ts` (directory)
3. `.pi/extensions/` (project-local, same patterns)
4. `settings.json` → `extensions` array
5. `settings.json` → `packages` array (npm/git)

Loaded via [jiti](https://github.com/unjs/jiti) — TypeScript runs without
compilation. Each extension exports a default function receiving `ExtensionAPI`.

Extensions load in discovery order. Event handlers chain: multiple extensions
can handle the same event. Tool registrations with the same name override
built-ins (last wins).

## System Prompt

Built by `system-prompt.js`:

1. Base coding assistant prompt
2. `SYSTEM.md` content (if exists in `~/.pi/agent/` or `.pi/`)
3. `--append-system-prompt` flag content
4. Available skills list (names + descriptions only)
5. Available tool descriptions
6. `before_agent_start` event can modify per-turn
