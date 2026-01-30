# .pi Configuration Repository

This repository contains my personal pi configuration, including:
- Custom extensions
- Subagents
- Skills
- Themes
- Prompts

## Development Setup

This repo is set up as a proper TypeScript project with formatting and linting.

### Install Dependencies

```bash
pnpm install
```

### Available Scripts

- `pnpm fmt` - Format code with oxfmt
- `pnpm lint` - Lint code with oxlint
- `pnpm check` - Type check with TypeScript
- `pnpm fix` - Format and auto-fix lint issues

### Dependencies

All pi packages are installed as devDependencies using `@latest`:
- `@mariozechner/pi-agent-core`
- `@mariozechner/pi-ai`
- `@mariozechner/pi-coding-agent`
- `@mariozechner/pi-tui`
- `@sinclair/typebox`

### Toolchain

- **Package Manager**: pnpm
- **Formatter**: oxfmt (configured in `.oxfmtrc.json`)
- **Linter**: oxlint (configured in `.oxlintrc.json`)
- **Type Checker**: TypeScript 5.x (configured in `tsconfig.json`)

### Adding New Extensions

1. Create a new `.ts` file in `agent/extensions/`
2. Export a default function that accepts `ExtensionAPI`
3. Run `pnpm check` to verify types
4. Run `pnpm fix` to format and lint

Example:
```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		// Your code here
	});
}
```
