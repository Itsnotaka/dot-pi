# Subagent Extension

Delegate tasks to specialized subagents with isolated context windows.

## Features

- **Isolated context**: Each subagent runs in a separate `pi` process
- **Streaming output**: See tool calls and progress as they happen
- **Parallel streaming**: All parallel tasks stream updates simultaneously
- **Markdown rendering**: Final output rendered with proper formatting (expanded
  view)
- **Usage tracking**: Shows turns, tokens, cost, and context usage per agent
- **Abort support**: Ctrl+C propagates to kill subagent processes

## Structure

```
subagents/
├── README.md            # This file
├── index.ts             # The extension (entry point)
├── agents.ts            # Agent discovery logic
├── agents/              # Reference agent definitions
│   ├── finder.md        # Fast parallel codebase search
│   ├── oracle.md        # Deep analysis, planning, debugging
│   ├── review.md        # Code review for quality/security
│   └── librarian.md     # Codebase understanding + external research
└── prompts/             # Workflow presets (prompt templates)
    ├── implement.md             # finder → oracle → implement directly
    ├── search-and-oracle.md     # finder → oracle (plan only)
    └── implement-and-review.md  # implement → review → apply feedback
```

## Installation

From the repository root, symlink the files:

```bash
# Symlink the extension (must be in a subdirectory with index.ts)
mkdir -p ~/.pi/agent/extensions/subagents
ln -sf "$(pwd)/agent/extensions/subagents/index.ts" ~/.pi/agent/extensions/subagents/index.ts
ln -sf "$(pwd)/agent/extensions/subagents/agents.ts" ~/.pi/agent/extensions/subagents/agents.ts

# Symlink agents
mkdir -p ~/.pi/agent/agents
for f in agent/extensions/subagents/agents/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/agents/$(basename "$f")
done

# Symlink workflow prompts
mkdir -p ~/.pi/agent/prompts
for f in agent/extensions/subagents/prompts/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/prompts/$(basename "$f")
done
```

## Security Model

**Project-local agents** (`.pi/agents/*.md`) are repo-controlled prompts that
can instruct the model to read files, run bash commands, etc.

**Default behavior:** Only loads **user-level agents** from
`~/.pi/agent/agents`.

To enable project-local agents, pass `agentScope: "both"` (or `"project"`). Only
do this for repositories you trust.

When running interactively, the tool prompts for confirmation before running
project-local agents. Set `confirmProjectAgents: false` to disable.

## Usage

### Single agent

```
Use finder to locate all authentication code
```

### Parallel execution

```
Run 2 finder tasks in parallel: one to find models, one to find providers
```

### Chained workflow

```
Use a chain: first have finder locate the read tool, then have oracle suggest improvements
```

### Workflow prompts

```
/implement add Redis caching to the session store
/search-and-oracle refactor auth to support OAuth
/implement-and-review add input validation to API endpoints
```

## Tool Modes

| Mode     | Parameter          | Description                                            |
| -------- | ------------------ | ------------------------------------------------------ |
| Single   | `{ agent, task }`  | One agent, one task                                    |
| Parallel | `{ tasks: [...] }` | Multiple agents run concurrently (max 8, 4 concurrent) |
| Chain    | `{ chain: [...] }` | Sequential with `{previous}` placeholder               |

## Output Display

**Collapsed view** (default):

- Status icon (✓/✗/⏳) and agent name
- Last 5-10 items (tool calls and text)
- Usage stats:
  `3 turns ↑input ↓output RcacheRead WcacheWrite $cost ctx:contextTokens model`

**Expanded view** (Ctrl+O):

- Full task text
- All tool calls with formatted arguments
- Final output rendered as Markdown
- Per-task usage (for chain/parallel)

**Parallel mode streaming**:

- Shows all tasks with live status (⏳ running, ✓ done, ✗ failed)
- Updates as each task makes progress
- Shows "2/3 done, 1 running" status

## Agent Definitions

Agents are markdown files with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
model: google-antigravity/claude-haiku-4-5-thinking
---

System prompt for the agent goes here.
```

**Locations:**

- `~/.pi/agent/agents/*.md` - User-level (always loaded)
- `.pi/agents/*.md` - Project-level (only with `agentScope: "project"` or
  `"both"`)

Project agents override user agents with the same name when
`agentScope: "both"`.

## Agents

| Agent       | Purpose                            | Model             | Tools                                 |
| ----------- | ---------------------------------- | ----------------- | ------------------------------------- |
| `finder`    | Fast parallel codebase search      | Google Antigravity Haiku 4.5  | read, grep, find, ls, bash            |
| `oracle`    | Deep analysis, planning, debugging | GPT-5.2                       | read, grep, find, ls, bash, WebSearch |
| `review`    | Code review for quality/security   | Google Antigravity Sonnet 4.5 | read, grep, find, ls, bash            |
| `librarian` | Codebase understanding + research  | Google Antigravity Sonnet 4.5 | read, grep, find, ls, bash, WebSearch |

## Workflow Prompts

| Prompt                          | Flow                                 |
| ------------------------------- | ------------------------------------ |
| `/implement <query>`            | finder → oracle → implement directly |
| `/search-and-oracle <query>`    | finder → oracle (plan only)          |
| `/implement-and-review <query>` | implement → review → apply feedback  |

## Error Handling

- **Exit code != 0**: Tool returns error with stderr/output
- **stopReason "error"**: LLM error propagated with error message
- **stopReason "aborted"**: User abort (Ctrl+C) kills subprocess, throws error
- **Chain mode**: Stops at first failing step, reports which step failed

## Limitations

- Output truncated to last 10 items in collapsed view (expand to see all)
- Agents discovered fresh on each invocation (allows editing mid-session)
- Parallel mode limited to 8 tasks, 4 concurrent
