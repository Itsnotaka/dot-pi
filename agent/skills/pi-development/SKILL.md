---
name: pi-development
description: Complete reference for developing pi extensions, tools, themes, skills, and prompt templates. Use when creating or modifying pi extensions, custom tools, TUI components, themes, model providers, or debugging pi internals.
---

# Pi Development

Pi is a terminal-based coding agent by Mario Zechner (`@mariozechner/pi-coding-agent`). It wraps LLMs with tools (read, bash, edit, write, grep, find, ls), a TUI, extensions, skills, and prompt templates. All Pi node modules are read-only.

## Quick Reference

| Topic | File |
|---|---|
| [Architecture](architecture.md) | Package structure, modes, core subsystems |
| [Extensions](extensions.md) | Extension API, events, lifecycle, custom tools |
| [TUI Components](tui.md) | Text, Container, Box, Markdown, custom rendering |
| [Configuration](configuration.md) | Settings, CLI flags, models, providers, auth |
| [Sessions](sessions.md) | Session storage, entries, branching, compaction |
| [Patterns](patterns.md) | Common recipes, subagent spawning, tool overrides |

## Key Packages

```
@mariozechner/pi-coding-agent  # Main package - extensions, tools, modes, CLI
@mariozechner/pi-tui           # TUI components - Text, Container, Box, SelectList
@mariozechner/pi-ai            # AI abstractions - Message, Model, Provider, StringEnum
@mariozechner/pi-agent-core    # Agent loop - AgentToolResult, tool execution
@sinclair/typebox              # Schema definitions for tool parameters
```

## File Locations

```
~/.pi/agent/
├── settings.json          # Global settings
├── auth.json              # Provider credentials (managed by /login)
├── SYSTEM.md              # Custom system prompt override
├── extensions/            # Global extensions (*.ts or */index.ts)
├── agents/                # Subagent definitions (*.md)
├── skills/                # Global skills (*/SKILL.md or *.md)
├── prompts/               # Prompt templates (*.md)
├── sessions/              # Session storage
└── bin/                   # CLI binary

.pi/                       # Project-local (same structure minus auth/settings)
├── extensions/
├── agents/
├── skills/
├── prompts/
└── settings.json
```

## Extension Skeleton

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    // ctx.ui, ctx.cwd, ctx.sessionManager, ctx.hasUI
  });

  pi.registerTool({
    name: "my_tool",
    label: "My Tool",
    description: "What the LLM sees",
    parameters: Type.Object({
      arg: Type.String({ description: "Argument" }),
    }),
    async execute(toolCallId, params, onUpdate, ctx, signal) {
      return {
        content: [{ type: "text", text: "result for LLM" }],
        details: { data: "for rendering and state" },
      };
    },
    renderCall(args, theme) { /* returns Component */ },
    renderResult(result, { expanded, isPartial }, theme) { /* returns Component */ },
  });

  pi.registerCommand("mycmd", {
    description: "Description",
    handler: async (args, ctx) => { /* ExtensionCommandContext */ },
  });
}
```

## Decision Tree

```
Need to add LLM-callable functionality?
└── registerTool()

Need to react to agent lifecycle?
└── pi.on("event_name", handler)

Need a /command?
└── registerCommand()

Need keyboard shortcut?
└── registerShortcut()

Need to show info on startup?
└── session_start + ctx.ui.setWidget()

Need to inject context per-turn?
└── before_agent_start or context event

Need to gate/block tool calls?
└── tool_call event, return { block: true }

Need to modify tool output?
└── tool_result event, return modified content

Need persistent state across restarts?
└── pi.appendEntry() + session_start reconstruction

Need to spawn isolated agent work?
└── spawn pi --mode json -p --no-session subprocess
```
