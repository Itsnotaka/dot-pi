/**
 * Handoff extension - transfer context to a new focused session
 *
 * Instead of compacting (which is lossy), handoff extracts what matters
 * for your next task and creates a new session with a generated prompt.
 *
 * Handoff encourages focused threads by moving relevant context forward
 * without stacking summaries. You specify the goal, and Amp generates
 * a focused prompt with relevant files for the new thread.
 *
 * Usage:
 *   /handoff now implement this for teams as well, not just individual users
 *   /handoff execute phase one of the created plan
 *   /handoff check the rest of the codebase and find other places that need this fix
 *
 * The generated prompt appears as a draft in the editor for review/editing
 * before you submit, ensuring no unintended loss of context.
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

Format:

## Context

[Concise, relevant-only background. Bullet points for decisions/constraints/findings.]

## Files

[Only files the new thread needs to read or modify. Use exact paths. Annotate when helpful:]
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

      // Gather conversation context from current branch
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

      // Convert to LLM format and serialize
      const llmMessages = convertToLlm(messages);
      const conversationText = serializeConversation(llmMessages);
      const currentSessionFile = ctx.sessionManager.getSessionFile();

      // Generate the handoff prompt with loader UI
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

      // Let user edit the generated prompt
      const editedPrompt = await ctx.ui.editor("Edit handoff prompt", result);

      if (editedPrompt === undefined) {
        ctx.ui.notify("Cancelled", "info");
        return;
      }

      // Create new session with parent tracking
      const newSessionResult = await ctx.newSession({
        parentSession: currentSessionFile,
      });

      if (newSessionResult.cancelled) {
        ctx.ui.notify("New session cancelled", "info");
        return;
      }

      // Set the edited prompt in the main editor for submission
      ctx.ui.setEditorText(editedPrompt);
      ctx.ui.notify("Handoff ready. Submit when ready.", "info");
    },
  });
}
