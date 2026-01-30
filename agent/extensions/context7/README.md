# Context7 Search Extension

Searches up-to-date library/package documentation via the [Context7](https://context7.com) REST API.

## Setup

1. Get a free API key at https://context7.com/dashboard
2. Add to `~/.pi/agent/settings.json`:

```json
{
	"context7": {
		"apiKey": "ctx7sk_..."
	}
}
```

Or set `CONTEXT7_API_KEY` env var.

## Tool: `context7-search`

**Parameters:**

- `libraryName` (required) — library name (e.g. `"react"`, `"next.js"`)
- `query` (required) — what you need (e.g. `"server components"`)
- `topic` (optional) — topic filter (e.g. `"routing"`)
- `tokens` (optional) — max doc tokens (default 5000)

Automatically resolves the library ID and fetches relevant docs in one call.
