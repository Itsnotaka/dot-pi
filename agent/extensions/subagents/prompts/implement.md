---
description:
  Full implementation workflow - finder gathers context, oracle creates plan,
  then implement directly
---

If external research is needed, run the "librarian" agent first (single mode)
and include its output in the chain.

Use the subagent tool with the chain parameter to execute this workflow:

1. First, use the "finder" agent to find all code relevant to: $@
2. Then, use the "oracle" agent to create an implementation plan for "$@" using
   the context from the previous step (use {previous} placeholder)

Execute this as a chain, passing output between steps via {previous}. Then
implement the plan yourself using the oracle's output as guidance.
