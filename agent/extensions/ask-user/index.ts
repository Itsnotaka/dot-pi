import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

const OWN_ANSWER = "Own answer";

type Question = {
  index: number;
  question: string;
  topic: string | null;
  options: string[];
};

type Answer = {
  index: number;
  topic: string | null;
  question: string;
  answer: string;
  optionIndex: number | null;
  isCustom: boolean;
};

function parseQuestionnaire(input: string): {
  questions: Question[];
  errors: string[];
} {
  const questions: Question[] = [];
  const errors: string[] = [];
  let current: Question | null = null;

  const pushCurrent = () => {
    if (current) questions.push(current);
    current = null;
  };

  const lines = input.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const questionMatch = line.match(/^\d+\.\s*\[question\]\s*(.+)$/i);
    if (questionMatch) {
      pushCurrent();
      current = {
        index: questions.length + 1,
        question: questionMatch[1].trim(),
        topic: null,
        options: [],
      };
      continue;
    }

    const topicMatch = line.match(/^\[topic\]\s*(.+)$/i);
    if (topicMatch) {
      if (!current) {
        errors.push(`Found [topic] before any [question]: ${line}`);
        continue;
      }
      current.topic = topicMatch[1].trim();
      continue;
    }

    const optionMatch = line.match(/^\[option\]\s*(.+)$/i);
    if (optionMatch) {
      if (!current) {
        errors.push(`Found [option] before any [question]: ${line}`);
        continue;
      }
      const option = optionMatch[1].trim();
      if (option) current.options.push(option);
      continue;
    }

    errors.push(`Unrecognized line: ${line}`);
  }

  pushCurrent();

  if (questions.length === 0) {
    errors.push("No [question] blocks found.");
  }

  if (questions.length > 4) {
    errors.push(`Too many questions (${questions.length}). Max is 4.`);
  }

  for (const q of questions) {
    const seen = new Set<string>();
    const cleaned: string[] = [];
    for (const option of q.options) {
      const trimmed = option.trim();
      if (!trimmed) continue;
      if (trimmed.toLowerCase() === OWN_ANSWER.toLowerCase()) continue;
      if (seen.has(trimmed)) continue;
      seen.add(trimmed);
      cleaned.push(trimmed);
    }
    q.options = cleaned;
    if (!q.topic) {
      errors.push(`Question ${q.index} is missing a [topic] line.`);
    }
    if (q.options.length < 2) {
      errors.push(
        `Question ${q.index} needs at least 2 [option] lines: ${q.question}`
      );
    }
    if (q.options.length > 4) {
      errors.push(
        `Question ${q.index} has too many [option] lines (${q.options.length}). Max is 4.`
      );
    }
  }

  return { questions, errors };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description:
      "Ask the user multiple-choice questions for quick clarification. " +
      "Provide a plain-text questionnaire with numbered questions, [topic], and [option] lines.",
    parameters: Type.Object({
      questionnaire: Type.String({
        description:
          "Plain-text questionnaire with numbered [question] blocks, [topic], and [option] lines.",
      }),
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

      const { questionnaire } = params as { questionnaire: string };
      const { questions, errors } = parseQuestionnaire(questionnaire);

      if (errors.length > 0) {
        return {
          content: [
            {
              type: "text",
              text: `Invalid questionnaire:\n- ${errors.join("\n- ")}`,
            },
          ],
          details: { ok: false, reason: "invalid_format", errors },
          isError: true,
        };
      }

      const answers: Answer[] = [];

      for (const q of questions) {
        const prompt = q.topic ? `${q.topic}\n${q.question}` : q.question;
        const choice = await ctx.ui.select(prompt, [...q.options, OWN_ANSWER]);

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
            index: q.index,
            topic: q.topic,
            question: q.question,
            answer: trimmed,
            optionIndex: null,
            isCustom: true,
          });
          continue;
        }

        answers.push({
          index: q.index,
          topic: q.topic,
          question: q.question,
          answer: choice,
          optionIndex: q.options.indexOf(choice),
          isCustom: false,
        });
      }

      const lines = answers.map((a) => {
        const topic = a.topic ? `[${a.topic}] ` : "";
        return `${a.index}. ${topic}${a.question} → ${a.answer}`;
      });

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
          0
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
