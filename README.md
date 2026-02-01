# dot-pi

Personal configuration for [pi](https://github.com/badlogic/pi-mono), a terminal-based AI coding agent by [Mario Zechner](https://github.com/badlogic). This repo contains custom extensions, subagents, skills, themes, and prompts.

This is a dotfiles-style repo meant to be cloned into `~/.pi`. It is **not** an npm package. You need [pi](https://github.com/badlogic/pi-mono) installed first.

## Quick Start

```bash
git clone https://github.com/Itsnotaka/dot-pi.git ~/.pi
cd ~/.pi
pnpm install
```

Pi will automatically load extensions, agents, skills, themes, and prompts from `~/.pi/agent/`.

## Structure

```
agent/
├── extensions/          # Custom tools and event hooks
│   ├── ask-user.ts          # Multi-choice questions for the LLM
│   ├── codebase.ts          # Clone and browse GitHub repos
│   ├── completion-sound.ts  # Audio notification on task completion
│   ├── context7/            # Library documentation search via Context7
│   ├── debug.ts             # Runtime debugging with fetch() instrumentation
│   ├── format-on-save.ts    # Auto-format files on write
│   ├── get-diagnostics/     # LSP diagnostics (TypeScript, Python, ESLint, oxlint)
│   ├── git-checkpoint.ts    # Auto-checkpoint git state
│   ├── handoff.ts           # Agent handoff between sessions
│   ├── look-at.ts           # File analysis (PDFs, images, media)
│   ├── pierre-system-theme.ts # System theme loader
│   ├── sandbox.ts           # Sandboxed code execution
│   ├── statusline.ts        # TUI status bar
│   ├── subagents/           # Spawn isolated agent processes (oracle, finder, review, librarian)
│   ├── tasks.ts             # Task list management
│   ├── websearch/           # Web search and URL fetching
│   └── worktree.ts          # Git worktree support
├── agents/              # Subagent definitions (.md)
├── skills/              # Domain-specific knowledge
│   ├── pi-development/            # Pi extension development reference
│   ├── turborepo/                 # Monorepo build system
│   ├── vercel-composition-patterns/ # React composition patterns
│   ├── vercel-react-best-practices/ # React/Next.js performance
│   ├── vercel-react-native-skills/  # React Native/Expo best practices
│   └── web-design-guidelines/       # Web interface guidelines
├── prompts/             # Reusable prompt templates
├── themes/              # Custom color themes (pierre-dark, pierre-light)
├── SYSTEM.md            # System prompt override
└── test/                # Extension tests
```

## Development

```bash
pnpm test          # Run tests (vitest)
pnpm typecheck     # Type check (tsgo)
pnpm lint          # Lint (oxlint)
pnpm fmt           # Format (oxfmt)
```

## Writing Extensions

Extensions are TypeScript files in `agent/extensions/` that export a default factory function receiving the `ExtensionAPI`:

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "my_tool",
    label: "My Tool",
    description: "What the LLM sees",
    parameters: Type.Object({
      arg: Type.String({ description: "Argument" }),
    }),
    async execute(toolCallId, params, onUpdate, ctx, signal) {
      return { content: [{ type: "text", text: "result" }] };
    },
  });
}
```

See `agent/skills/pi-development/` for the full extension API reference.

## Notes

- `auth.json`, `settings.json`, and `sessions/` are gitignored — they contain credentials and local state.
- Test files live in `agent/test/`, not alongside extensions, to prevent the extension loader from picking them up.
- Skills are auto-loaded into agent context based on task relevance.

## License

MIT
