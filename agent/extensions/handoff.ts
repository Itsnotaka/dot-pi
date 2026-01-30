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

import { complete, type Message } from "@mariozechner/pi-ai";
import type { ExtensionAPI, SessionEntry } from "@mariozechner/pi-coding-agent";
import { BorderedLoader, convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";

const SYSTEM_PROMPT = `You are a context transfer assistant for Amp's Handoff feature. Given a conversation history and the user's goal for a new thread, generate a focused, self-contained prompt that extracts what matters for the next task.

Your job is to:
1. Extract ONLY the relevant context needed for the user's specific goal (not a full summary)
2. Identify key decisions, approaches, and findings that matter for the next task
3. List specific files that were discussed, modified, or are relevant to the goal
4. Clearly state the next task based on the user's goal
5. Make it self-contained so the new thread can proceed independently

Be selective - don't carry over everything. Focus on what's needed for the stated goal.
Do not include preamble like "Here's the prompt" - output only the prompt itself.

Format:
## Context
[Only relevant background for the new task - be concise]

Key decisions/findings:
- [Decision 1]
- [Finding 2]

## Files
- path/to/relevant/file1.ts
- path/to/relevant/file2.ts

## Task
[Clear, specific description of what to do next based on user's goal]`;

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
				.filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
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
			const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(tui, theme, `Generating handoff prompt...`);
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
						{ apiKey, signal: loader.signal },
					);

					if (response.stopReason === "aborted") {
						return null;
					}

					return response.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
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
			});

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
