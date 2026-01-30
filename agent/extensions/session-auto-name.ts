/**
 * Session Auto-Name Extension
 *
 * After the first agent turn, generates a short session title via Claude Haiku 4.5
 * using a tool call for structured output. Persists via setSessionName so /resume
 * shows meaningful titles instead of "pi".
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL_ID = "claude-haiku-4-5";
const MAX_CONTEXT_CHARS = 1500;
const MAX_TITLE_LENGTH = 60;

interface TitleToolResult {
	title: string;
}

function extractConversationPreview(entries: any[]): string {
	const snippets: string[] = [];
	let chars = 0;

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (!msg || (msg.role !== "user" && msg.role !== "assistant")) continue;

		let text = "";
		if (typeof msg.content === "string") {
			text = msg.content;
		} else if (Array.isArray(msg.content)) {
			text = msg.content
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join(" ");
		}
		if (!text) continue;

		const trimmed = text.slice(0, 500).trim();
		if (!trimmed) continue;

		const label = msg.role === "user" ? "User" : "Assistant";
		const snippet = `${label}: ${trimmed}`;
		snippets.push(snippet);
		chars += snippet.length;
		if (chars >= MAX_CONTEXT_CHARS) break;
	}

	return snippets.join("\n\n");
}

async function generateTitle(apiKey: string, conversationPreview: string): Promise<string | null> {
	const tool = {
		name: "set_title",
		description: "Set the session title based on conversation content.",
		input_schema: {
			type: "object" as const,
			properties: {
				title: {
					type: "string" as const,
					description: "A concise session title, max 6 words. No quotes, no punctuation at the end.",
				},
			},
			required: ["title"],
		},
	};

	const body = {
		model: MODEL_ID,
		max_tokens: 128,
		tools: [tool],
		tool_choice: { type: "tool", name: "set_title" },
		messages: [
			{
				role: "user",
				content: `Based on this conversation, generate a short descriptive title (max 6 words) that captures what this session is about.\n\n${conversationPreview}`,
			},
		],
	};

	const response = await fetch(ANTHROPIC_API_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-api-key": apiKey,
			"anthropic-version": "2023-06-01",
		},
		body: JSON.stringify(body),
	});

	if (!response.ok) return null;

	const data = (await response.json()) as any;
	const toolUse = data.content?.find((c: any) => c.type === "tool_use" && c.name === "set_title");
	if (!toolUse?.input?.title) return null;

	let title = (toolUse.input as TitleToolResult).title.trim();
	title = title.replace(/^["']|["']$/g, "").trim();
	title = title.replace(/[.!?]+$/, "").trim();
	if (title.length > MAX_TITLE_LENGTH) {
		title = title.slice(0, MAX_TITLE_LENGTH).replace(/\s+\S*$/, "").trim();
	}

	return title || null;
}

export default function (pi: ExtensionAPI) {
	let named = false;
	let naming = false;
	let currentSessionId: string | undefined;

	function reset(ctx: any) {
		named = false;
		naming = false;
		currentSessionId = ctx.sessionManager.getSessionId();
		if (pi.getSessionName()) {
			named = true;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		reset(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		reset(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (named || naming) return;

		const prompt = event.prompt;
		if (!prompt?.trim()) return;

		const apiKey = await ctx.modelRegistry.getApiKeyForProvider("anthropic");
		if (!apiKey) return;

		const sessionId = ctx.sessionManager.getSessionId();
		if (!sessionId) return;

		naming = true;
		currentSessionId = sessionId;

		// Fire and forget — don't block the agent turn
		generateTitle(apiKey, `User: ${prompt.slice(0, MAX_CONTEXT_CHARS)}`)
			.then((title) => {
				if (!title || named) return;
				if (ctx.sessionManager.getSessionId() !== currentSessionId) return;

				pi.setSessionName(title);
				named = true;

				if (ctx.hasUI) {
					ctx.ui.setTitle(title);
				}
			})
			.catch(() => {})
			.finally(() => {
				naming = false;
			});
	});
}
