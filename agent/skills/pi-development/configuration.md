# Configuration

## settings.json

Located at `~/.pi/agent/settings.json` (global) or `.pi/settings.json` (project).

```jsonc
{
  // Model defaults
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-5",
  "defaultThinkingLevel": "high",      // off, minimal, low, medium, high, xhigh
  "enabledModels": [                    // restrict Ctrl+P cycling
    "anthropic/claude-sonnet-4-5",
    "anthropic/claude-opus-4-5"
  ],

  // Discovery paths
  "skills": ["~/extra-skills"],         // additional skill directories
  "extensions": ["/path/to/ext.ts"],    // additional extension files
  "packages": ["npm:@foo/bar@1.0.0"],   // npm/git packages

  // Features
  "websearch": { "apiKey": "..." },     // Parallel Search API key
  "enableSkillCommands": true,          // /skill:name commands

  // Display
  "lastChangelogVersion": "0.50.3"
}
```

## CLI Flags

```
pi [options] [prompt...]

Mode:
  --mode <mode>              interactive (default), json, rpc
  -p                         Print mode (one-shot, exit after response)

Model:
  --provider <name>          Provider: anthropic, openai, google, github-copilot, ...
  --model <id>               Model ID: claude-sonnet-4-5, gpt-4o, etc.
  --thinking <level>         off, minimal, low, medium, high, xhigh
  --api-key <key>            API key (or env var name)
  --models <patterns>        Ctrl+P cycling: "sonnet:high,haiku:low", "anthropic/*"

Session:
  --no-session               Don't persist session
  --resume [id]              Resume session

Prompt:
  --system-prompt <text>     Replace system prompt
  --append-system-prompt <text|file>  Append to system prompt
  --skill <path>             Load skill (repeatable)
  --no-skills                Disable skill discovery

Tools:
  --tools <list>             Comma-separated: read,bash,edit,write,grep,find,ls
  --no-tools                 Disable all built-in tools

Extensions:
  -e, --extension <path>     Load extension (repeatable)
  --no-extensions            Disable extension discovery
```

## Model Selection

`--model` takes the model ID, `--provider` takes the provider name. For subagents and programmatic use, combine as `provider/model`:

```bash
pi --provider anthropic --model claude-sonnet-4-5
pi --provider github-copilot --model gpt-5.2
```

## Auth

Managed via `/login` command in interactive mode. Stored in `~/.pi/agent/auth.json`:

```jsonc
{
  "anthropic": { "type": "oauth", "refresh": "...", "access": "...", "expires": 123 },
  "github-copilot": { "type": "oauth", "refresh": "...", "access": "...", "expires": 123 }
}
```

Environment variables also work: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`.

## Custom Providers

```typescript
pi.registerProvider("my-proxy", {
  baseUrl: "https://proxy.example.com",
  apiKey: "ENV_VAR_NAME",            // or literal key
  api: "anthropic-messages",          // or openai-responses, openai-completions
  headers: { "X-Custom": "value" },
  authHeader: true,                   // adds Authorization: Bearer
  models: [{
    id: "claude-sonnet-4-5",
    name: "Sonnet via proxy",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 16384,
  }],
  oauth: { /* login flow */ },
});

// Override baseUrl for existing provider
pi.registerProvider("anthropic", { baseUrl: "https://proxy.example.com" });
```

## Prompt Templates

Markdown files in `~/.pi/agent/prompts/` or `.pi/prompts/`. Invoked as `/name args`.

```markdown
---
description: What this template does
---
Template content here. Use $@ for all args, $1 $2 for positional.
```

## Packages

Install via settings.json:

```json
{
  "packages": [
    "npm:@scope/package@version",
    "git:github.com/user/repo@tag"
  ]
}
```

Packages can provide extensions, skills, prompts, themes, and agents via `pi` field in package.json.
