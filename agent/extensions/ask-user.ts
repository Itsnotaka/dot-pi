import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

const OWN_ANSWER = "Own answer";

type Answer = {
  index: number;
  topic: string;
  question: string;
  answer: string;
  optionIndex: number | null;
  isCustom: boolean;
};

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description:
      "Ask the user multiple-choice questions for quick clarification. " +
      "Provide 1-4 questions, each with a short topic label, the question text, and 2-4 options. " +
      'A "Type your own answer" option is added automatically — do not include catch-all options.',
    parameters: Type.Object({
      questions: Type.Array(
        Type.Object({
          topic: Type.String({
            description: "Short label for the question (max 30 chars)",
          }),
          question: Type.String({ description: "The full question text" }),
          options: Type.Array(Type.String({ description: "A choice option" }), {
            description: "2-4 answer choices",
            minItems: 2,
            maxItems: 4,
          }),
        }),
        { description: "1-4 questions to ask the user", minItems: 1, maxItems: 4 },
      ),
    }),

    async execute(_toolCallId, params, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        return {
          content: [
            { type: "text", text: "ask_user requires interactive mode." },
          ],
          details: { ok: false, reason: "no_ui" },
          isError: true,
        };
      }

      const { questions } = params as {
        questions: { topic: string; question: string; options: string[] }[];
      };

      const errors: string[] = [];
      if (questions.length === 0) errors.push("No questions provided.");
      if (questions.length > 4)
        errors.push(`Too many questions (${questions.length}). Max is 4.`);

      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        const deduplicated = [...new Set(q.options.filter((o) => o.trim()))];
        const filtered = deduplicated.filter(
          (o) => o.toLowerCase() !== OWN_ANSWER.toLowerCase(),
        );
        questions[i].options = filtered;
        if (filtered.length < 2)
          errors.push(`Question ${i + 1} needs at least 2 options.`);
        if (filtered.length > 4)
          errors.push(`Question ${i + 1} has too many options (max 4).`);
      }

      if (errors.length > 0) {
        return {
          content: [
            {
              type: "text",
              text: `Invalid questions:\n- ${errors.join("\n- ")}`,
            },
          ],
          details: { ok: false, reason: "invalid_format", errors },
          isError: true,
        };
      }

      const answers: Answer[] = [];

      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        const prompt = `${q.topic}\n${q.question}`;
        const choice = await ctx.ui.select(prompt, [
          ...q.options,
          OWN_ANSWER,
        ]);

        if (!choice) {
          return {
            content: [{ type: "text", text: "Cancelled." }],
            details: { ok: false, cancelled: true },
            isError: true,
          };
        }

        if (choice === OWN_ANSWER) {
          const response = await ctx.ui.input("Your answer", q.question);
          if (response === undefined) {
            return {
              content: [{ type: "text", text: "Cancelled." }],
              details: { ok: false, cancelled: true },
              isError: true,
            };
          }
          const trimmed = response.trim();
          if (!trimmed) {
            return {
              content: [{ type: "text", text: "Empty answer." }],
              details: { ok: false, reason: "empty_answer" },
              isError: true,
            };
          }
          answers.push({
            index: i + 1,
            topic: q.topic,
            question: q.question,
            answer: trimmed,
            optionIndex: null,
            isCustom: true,
          });
          continue;
        }

        answers.push({
          index: i + 1,
          topic: q.topic,
          question: q.question,
          answer: choice,
          optionIndex: q.options.indexOf(choice),
          isCustom: false,
        });
      }

      const lines = answers.map(
        (a) => `${a.index}. [${a.topic}] ${a.question} → ${a.answer}`,
      );

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { ok: true, answers },
      };
    },

    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", "ask_user"), 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as
        | { ok?: boolean; answers?: Answer[]; errors?: string[] }
        | undefined;
      if (!expanded) {
        if (!details?.ok) {
          return new Text(theme.fg("error", "✗ ask_user"), 0, 0);
        }
        const count = details.answers?.length ?? 0;
        const label = count === 1 ? "1 answer" : `${count} answers`;
        return new Text(
          `${theme.fg("success", "✓")} ${theme.fg("muted", label)}`,
          0,
          0,
        );
      }

      const text =
        result.content?.[0]?.type === "text"
          ? result.content[0].text
          : "(no output)";
      return new Text(theme.fg("toolOutput", text), 0, 0);
    },
  });
}
