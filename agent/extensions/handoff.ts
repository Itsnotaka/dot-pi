/**
 * Handoff extension — transfer context to a new focused session.
 *
 * Generates a prompt for a new session using the current conversation and goal.
 *
 * Usage:
 *   /handoff now implement this for teams as well
 *   /handoff execute phase one of the created plan
 *   /handoff check the rest of the codebase for this fix
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { complete, type Message } from "@mariozechner/pi-ai";
import {
  BorderedLoader,
  convertToLlm,
  serializeConversation,
} from "@mariozechner/pi-coding-agent";

const SYSTEM_PROMPT = `You generate handoff prompts. A handoff transfers context from this conversation into a new, blank thread. The new thread has ZERO prior context — your output is all it gets.

Rules:
- Output ONLY the prompt. No preamble, no "Here's the prompt", no wrapping.
- Be selective, but not vague: include the concrete details the new thread needs to execute the stated goal.
- Never summarize the whole conversation. Extract only what is relevant to the goal.
- Include concrete details: exact file paths, function names, type signatures, API shapes, error messages, config values. Vague references like "the auth module" are useless without a path.
- State decisions as facts, not history.
- If code patterns or conventions were established, show a brief example rather than describing them.
- The task must be specific and actionable.

Special case — plan phases:
- If the user's goal involves executing a specific plan phase (e.g. "execute phase 1"), expand that phase into a detailed, ordered implementation checklist with concrete steps, file paths, and commands to run.

Perspective:
- In the "## Context" section only, write from first-person perspective ("I did...", "I found...").
- In all other sections, write directly as instructions for the new thread (imperative voice).

Format:

## Context

[Concise, relevant-only background. Bullet points for decisions/constraints/findings.]

## Files

[Only files the new thread needs to read or modify. Max 10. Most important first.]
- path/to/file.ts — what's relevant about it
- path/to/other.ts

## Task

[Specific, actionable goal. Include a step-by-step checklist when appropriate. Include acceptance criteria or scope boundaries when they exist.]`;

export default function (pi: ExtensionAPI) {
  pi.registerCommand("handoff", {
    description: "Transfer context to a new focused session",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("handoff requires interactive mode", "error");
        return;
      }

      if (!ctx.model) {
        ctx.ui.notify("No model selected", "error");
        return;
      }

      let goal = args.trim();
      if (!goal) {
        const input = await ctx.ui.input(
          "Handoff goal",
          "What should the new thread accomplish?"
        );
        if (!input) {
          return;
        }
        goal = input.trim();
        if (!goal) {
          return;
        }
      }

      const branch = ctx.sessionManager.getBranch();
      const messages = branch.flatMap((entry) =>
        entry.type === "message" ? [entry.message] : []
      );

      if (messages.length === 0) {
        ctx.ui.notify("No conversation to hand off", "error");
        return;
      }

      const llmMessages = convertToLlm(messages);
      const conversationText = serializeConversation(llmMessages);
      const currentSessionFile = ctx.sessionManager.getSessionFile();

      const result = await ctx.ui.custom<string | null>(
        (tui, theme, _kb, done) => {
          const loader = new BorderedLoader(
            tui,
            theme,
            `Generating handoff prompt...`
          );
          loader.onAbort = () => done(null);

          const doGenerate = async () => {
            const apiKey = await ctx.modelRegistry.getApiKey(ctx.model!);

            const userMessage: Message = {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `## Conversation History\n\n${conversationText}\n\n## User's Goal for New Thread\n\n${goal}`,
                },
              ],
              timestamp: Date.now(),
            };

            const response = await complete(
              ctx.model!,
              { systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
              { apiKey, signal: loader.signal }
            );

            if (response.stopReason === "aborted") {
              return null;
            }

            return response.content
              .flatMap((c) => (c.type === "text" ? [c.text] : []))
              .join("\n");
          };

          doGenerate()
            .then(done)
            .catch((err) => {
              console.error("Handoff generation failed:", err);
              done(null);
            });

          return loader;
        }
      );

      if (result === null) {
        ctx.ui.notify("Cancelled", "info");
        return;
      }

      const editedPrompt = await ctx.ui.editor("Edit handoff prompt", result);

      if (editedPrompt === undefined) {
        ctx.ui.notify("Cancelled", "info");
        return;
      }

      const newSessionResult = await ctx.newSession({
        parentSession: currentSessionFile,
      });

      if (newSessionResult.cancelled) {
        ctx.ui.notify("New session cancelled", "info");
        return;
      }

      ctx.ui.setEditorText(editedPrompt);
    },
  });
}
