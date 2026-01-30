---
description: Full implementation workflow - search gathers context, oracle creates plan, worker implements
---

If external research is needed, run the "librarian" agent first (single mode) and include its output in the chain.

Use the subagent tool with the chain parameter to execute this workflow:

1. First, use the "search" agent to find all code relevant to: $@
2. Then, use the "oracle" agent to create an implementation plan for "$@" using the context from the previous step (use {previous} placeholder)
3. Finally, use the "worker" agent to implement the plan from the previous step (use {previous} placeholder)

Execute this as a chain, passing output between steps via {previous}.
