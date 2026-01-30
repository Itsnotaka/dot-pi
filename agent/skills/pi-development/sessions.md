# Sessions

## Storage

Sessions stored in `~/.pi/agent/sessions/` as JSON files. Each file is a flat
array of entries representing a tree (not linear). The "current branch" is the
path from root to the current leaf.

## Entry Types

```typescript
type SessionEntry =
  | {
      type: "session";
      id: string;
      version: number;
      timestamp: string;
      cwd: string;
    }
  | {
      type: "message";
      id: string;
      parentId: string;
      message: Message;
      timestamp: number;
    }
  | {
      type: "compaction";
      id: string;
      parentId: string;
      summary: string;
      firstKeptEntryId: string;
      tokensBefore: number;
    }
  | {
      type: "custom";
      id: string;
      parentId: string;
      customType: string;
      data?: any;
    };
```

Every entry has `id` and `parentId` forming a tree. Multiple children = branches
(from `/fork` or `/tree`).

## Message Roles

```typescript
type Message =
  | { role: "user"; content: ContentPart[]; timestamp: number }
  | {
      role: "assistant";
      content: ContentPart[];
      usage?: Usage;
      model?: string;
      stopReason?: string;
    }
  | {
      role: "toolResult";
      toolCallId: string;
      toolName: string;
      content: ContentPart[];
      details?: any;
      isError?: boolean;
    }
  | {
      role: "custom";
      customType: string;
      content: string;
      display?: boolean;
      details?: any;
    };
```

## SessionManager API

Available via `ctx.sessionManager` (read-only in event handlers):

```typescript
sessionManager.getEntries(); // All entries in session file
sessionManager.getBranch(); // Entries on current branch (root → leaf)
sessionManager.getLeafId(); // Current leaf entry ID
sessionManager.getSessionFile(); // Session file path (undefined if ephemeral)
sessionManager.getLabel(entryId); // Get label for entry
```

## Branching Model

```
session_start (root)
  └─ user message 1
       └─ assistant message 1
            ├─ user message 2a (branch A - current)
            │    └─ assistant 2a
            └─ user message 2b (branch B - from /fork)
                 └─ assistant 2b
```

`getBranch()` returns the linear path to the current leaf. `getEntries()`
returns everything including other branches.

## Compaction

When context grows too large, pi compacts by summarizing older messages:

1. `session_before_compact` fires (extensions can cancel or provide custom
   summary)
2. LLM generates summary of older messages
3. Summary replaces compacted messages in context
4. `session_compact` fires
5. `firstKeptEntryId` marks where real messages resume

Extensions can trigger: `ctx.compact({ customInstructions: "Focus on X" })`.

## Persistent Extension State

Use `pi.appendEntry()` for state that survives restarts but isn't sent to the
LLM:

```typescript
pi.appendEntry("my-extension-state", { counter: 42 });
```

Reconstruct on `session_start` by scanning `getEntries()` for entries with
`type === "custom"` and matching `customType`.
