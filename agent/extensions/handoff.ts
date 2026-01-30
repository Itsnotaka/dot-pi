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

import type { ExtensionAPI, SessionEntry } from "@mariozechner/pi-coding-agent";

import { complete, type Message } from "@mariozechner/pi-ai";
import {
  BorderedLoader,
  convertToLlm,
  serializeConversation,
} from "@mariozechner/pi-coding-agent";

const SYSTEM_PROMPT = `You generate handoff prompts. A handoff transfers context from this conversation into a new, blank thread. The new thread has ZERO prior context — your output is all it gets.

Rules:
- Output ONLY the prompt. No preamble, no "Here's the prompt", no wrapping.
- Be ruthlessly selective. Carry forward only what the new thread needs for the stated goal.
- Never summarize the whole conversation. Extract, don't recap.
- Include concrete details: exact file paths, function names, type signatures, API shapes, error messages, config values. Vague references like "the auth module" are useless without a path.
- State decisions as facts, not history. Write "We use JWT with RS256" not "We discussed JWT vs session tokens and decided on JWT with RS256".
- If code patterns or conventions were established, show a brief example rather than describing them.
- The task must be specific and actionable. "Implement X" beats "Continue working on X".

When extracting context, write from first person perspective ("I did...", "I told you...").

Consider what would be useful to know based on the user's goal:
- What did I just do or implement?
- What instructions did I already give which are still relevant?
- What files am I working on that should continue?
- Did I provide a plan or spec that should be included?
- What libraries, patterns, constraints, or preferences matter?
- What important technical details did I discover?
- What caveats, limitations, or open questions exist?

Focus on capabilities and behavior, not file-by-file changes. Avoid excessive implementation details unless critical.

Format:

## Context

[Concise, relevant-only background. Bullet points for decisions/constraints/findings.]

## Files

[Only files the new thread needs to read or modify. Max 10. Most important first.]
- path/to/file.ts — what's relevant about it
- path/to/other.ts

## Task

[Specific, actionable goal. Include acceptance criteria or scope boundaries when they exist.]`;

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

      const goal = args.trim();
      if (!goal) {
        ctx.ui.notify("Usage: /handoff <goal for new thread>", "error");
        return;
      }

      const branch = ctx.sessionManager.getBranch();
      const messages = branch
        .filter(
          (entry): entry is SessionEntry & { type: "message" } =>
            entry.type === "message"
        )
        .map((entry) => entry.message);

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
              .filter(
                (c): c is { type: "text"; text: string } => c.type === "text"
              )
              .map((c) => c.text)
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
      ctx.ui.notify("Handoff ready. Submit when ready.", "info");
    },
  });
}
