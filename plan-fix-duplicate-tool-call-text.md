# Plan
1. Add toolCallId normalization helper (strip "|" suffix) for pending tool map keys.
2. Use normalized keys in message_update, tool_execution_start/update/end, and renderSessionContext toolCall/toolResult matching.
3. Smoke test websearch/context7 in interactive mode to confirm no duplicate tool rows.

Questions:
- Does duplication happen for built-in tools too?
- Which provider/model is active when the issue appears?
