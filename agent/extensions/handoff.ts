/**
 * Handoff extension — transfer context to a new focused session.
 *
 * Usage:
 *   /handoff now implement this for teams as well
 *   /handoff execute phase one of the created plan
 *   /handoff check the rest of the codebase for this fix
 */

import type { ExtensionAPI, SessionEntry } from "@mariozechner/pi-coding-agent";

const HANDOFF_INSTRUCTIONS = `You are writing a handoff note for another AI agent with no access to this chat.

Extract only task-relevant context from this conversation.

Rules:
- Be concise and concrete.
- Include exact file paths, symbols, commands, errors, and decisions when relevant.
- Keep only information needed to continue the work.
- Do not invent missing details.
- If a critical detail is unknown, state that briefly.
- Do not call tools.

Output format:
- Plain markdown.
- Include sections: Context, Files, Task.
- In Task, provide specific next actions.`;

type HandoffExtractionResult = { kind: "ok"; text: string } | { kind: "error"; message: string };

function extractAssistantText(entries: SessionEntry[], fromIndex: number): HandoffExtractionResult {
  for (let i = entries.length - 1; i >= fromIndex; i--) {
    const entry = entries[i];

    if (entry.type !== "message") {
      continue;
    }

    const message = entry.message;
    if (message.role !== "assistant") {
      continue;
    }

    if (message.stopReason === "aborted") {
      return { kind: "error", message: "Handoff generation was cancelled." };
    }

    if (message.stopReason === "error") {
      return {
        kind: "error",
        message: message.errorMessage?.trim() || "Handoff generation failed.",
      };
    }

    const text = message.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n")
      .trim();

    if (!text) {
      continue;
    }

    return { kind: "ok", text };
  }

  return { kind: "error", message: "Failed to capture handoff note from the assistant response." };
}

async function waitForHandoffTurnToStart(
  ctx: {
    isIdle: () => boolean;
    hasPendingMessages: () => boolean;
    sessionManager: { getBranch: () => SessionEntry[] };
  },
  branchLengthBefore: number,
  timeoutMs = 5000,
): Promise<boolean> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (
      !ctx.isIdle() ||
      ctx.hasPendingMessages() ||
      ctx.sessionManager.getBranch().length > branchLengthBefore
    ) {
      return true;
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }

  return false;
}

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

      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        ctx.ui.notify(
          "Please wait for the current turn to finish before running /handoff.",
          "error",
        );
        return;
      }

      let goal = args.trim();
      if (!goal) {
        const input = await ctx.ui.input("Handoff goal", "What should the new thread accomplish?");
        if (!input) {
          return;
        }
        goal = input.trim();
        if (!goal) {
          return;
        }
      }

      const currentSessionFile = ctx.sessionManager.getSessionFile();
      const branchLengthBefore = ctx.sessionManager.getBranch().length;
      const handoffRequest = `${HANDOFF_INSTRUCTIONS}\n\nGoal for the next thread:\n${goal}`;

      pi.sendUserMessage(handoffRequest);
      ctx.ui.notify("Generating handoff note...", "info");

      const started = await waitForHandoffTurnToStart(ctx, branchLengthBefore);
      if (!started) {
        ctx.ui.notify("Handoff generation did not start in time.", "error");
        return;
      }

      await ctx.waitForIdle();

      const extraction = extractAssistantText(ctx.sessionManager.getBranch(), branchLengthBefore);
      if (extraction.kind === "error") {
        ctx.ui.notify(`Handoff failed: ${extraction.message}`, "error");
        return;
      }

      const initialPrompt = `${extraction.text}\n\n## Task\n\n${goal}`;
      const editedPrompt = await ctx.ui.editor("Edit handoff prompt", initialPrompt);

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
