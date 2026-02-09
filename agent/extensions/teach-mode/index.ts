/**
 * Teach Mode Extension
 *
 * Educational mode that transforms Pi into a teaching assistant rather than a code generator.
 * Inspired by Carson Gross's teaching philosophy for AI agents.
 *
 * Features:
 * - /teach command or Ctrl+Alt+T to toggle
 * - Restricts code generation to small examples (2-5 lines)
 * - Encourages explanation over implementation
 * - Tracks learning objectives and concepts
 * - Quiz mode to verify understanding
 * - Progress tracking for learning journey
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import {
  extractLearningObjectives,
  extractQuizQuestions,
  isCodeGenerationRequest,
  markMasteredObjectives,
  type LearningObjective,
  type QuizQuestion,
} from "./utils.js";

const TEACH_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire", "ask_user"];
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];

// Type guard for assistant messages
function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
  return m.role === "assistant" && Array.isArray(m.content);
}

// Extract text content from an assistant message
function getTextContent(message: AssistantMessage): string {
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export default function teachModeExtension(pi: ExtensionAPI): void {
  let teachModeEnabled = false;
  let learningObjectives: LearningObjective[] = [];
  let currentQuiz: QuizQuestion[] = [];
  let quizMode = false;

  function activateTools(toolNames: string[]): void {
    const available = new Set(pi.getAllTools().map((tool) => tool.name));
    pi.setActiveTools(toolNames.filter((toolName) => available.has(toolName)));
  }

  pi.registerFlag("teach", {
    description: "Start in teach mode (learning-focused guidance)",
    type: "boolean",
    default: false,
  });

  function updateStatus(ctx: ExtensionContext): void {
    // Footer status
    if (quizMode && currentQuiz.length > 0) {
      const answered = currentQuiz.filter((q) => q.answered).length;
      ctx.ui.setStatus(
        "teach-mode",
        ctx.ui.theme.fg("accent", `📝 ${answered}/${currentQuiz.length}`),
      );
    } else if (teachModeEnabled) {
      ctx.ui.setStatus("teach-mode", ctx.ui.theme.fg("warning", "🎓 teach"));
    } else {
      ctx.ui.setStatus("teach-mode", undefined);
    }

    // Widget showing learning objectives
    if (teachModeEnabled && learningObjectives.length > 0) {
      const lines = learningObjectives.map((obj) => {
        if (obj.mastered) {
          return (
            ctx.ui.theme.fg("success", "✓ ") +
            ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(obj.text))
          );
        }
        return `${ctx.ui.theme.fg("muted", "○ ")}${obj.text}`;
      });
      ctx.ui.setWidget("learning-objectives", lines);
    } else {
      ctx.ui.setWidget("learning-objectives", undefined);
    }
  }

  function toggleTeachMode(ctx: ExtensionContext): void {
    teachModeEnabled = !teachModeEnabled;
    quizMode = false;
    currentQuiz = [];

    if (teachModeEnabled) {
      activateTools(TEACH_MODE_TOOLS);
      ctx.ui.notify("Teach mode enabled. I'm now your teaching assistant!");
    } else {
      activateTools(NORMAL_MODE_TOOLS);
      learningObjectives = [];
      ctx.ui.notify("Teach mode disabled. Full coding access restored.");
    }
    updateStatus(ctx);
    persistState();
  }

  function persistState(): void {
    pi.appendEntry("teach-mode", {
      enabled: teachModeEnabled,
      objectives: learningObjectives,
      quiz: currentQuiz,
      quizMode,
    });
  }

  pi.registerCommand("teach", {
    description: "Toggle teach mode (learning-focused guidance)",
    handler: async (_args, ctx) => toggleTeachMode(ctx),
  });

  pi.registerCommand("objectives", {
    description: "Show current learning objectives",
    handler: async (_args, ctx) => {
      if (learningObjectives.length === 0) {
        ctx.ui.notify("No learning objectives yet. Start a lesson first!", "info");
        return;
      }
      const list = learningObjectives
        .map((obj, i) => `${i + 1}. ${obj.mastered ? "✓" : "○"} ${obj.text}`)
        .join("\n");
      ctx.ui.notify(`Learning Progress:\n${list}`, "info");
    },
  });

  pi.registerCommand("quiz", {
    description: "Start a quiz on recent concepts",
    handler: async (_args, ctx) => {
      if (!teachModeEnabled) {
        ctx.ui.notify("Enable teach mode first with /teach", "warning");
        return;
      }
      quizMode = true;
      updateStatus(ctx);
      persistState();
      pi.sendUserMessage("Quiz me on the concepts we just covered");
    },
  });

  pi.registerShortcut(Key.ctrlAlt("t"), {
    description: "Toggle teach mode",
    handler: async (ctx) => toggleTeachMode(ctx),
  });

  pi.on("input", async (event, ctx) => {
    if (!teachModeEnabled) return { action: "continue" };
    if (event.source === "extension") return { action: "continue" };

    if (isCodeGenerationRequest(event.text)) {
      ctx.ui.notify(
        "Teach mode: ask for explanation or guidance, not full implementation.",
        "info",
      );
      return {
        action: "transform",
        text: `The user asked for direct implementation: "${event.text}".

In teach mode, do not provide full solutions.
Respond as a teaching assistant:
- explain the underlying concept
- ask 1-2 guiding questions
- give a minimal example (2-5 lines max)
- suggest next steps the user should implement`,
        images: event.images,
      };
    }

    return { action: "continue" };
  });

  // Inject teaching context
  pi.on("before_agent_start", async () => {
    if (!teachModeEnabled) return;

    if (quizMode && currentQuiz.length > 0) {
      const remaining = currentQuiz.filter((q) => !q.answered);
      const quizList = remaining.map((q, i) => `${i + 1}. ${q.question}`).join("\n");
      return {
        message: {
          customType: "teach-quiz-context",
          content: `[QUIZ MODE - Educational Assessment]

Ask these questions one at a time:
${quizList}

After each answer:
- Provide feedback (correct/incorrect)
- Explain the concept if incorrect
- Mark with [QUIZ:n:CORRECT] or [QUIZ:n:INCORRECT]`,
          display: false,
        },
      };
    }

    return {
      message: {
        customType: "teach-mode-context",
        content: `[TEACH MODE ACTIVE - Teaching Assistant Role]

You are functioning as a teaching assistant. Your goal is to help the student LEARN, not to solve problems for them.

## What You SHOULD Do:
- Explain concepts when the student is confused
- Point to relevant documentation or materials
- Review code the student has written and suggest improvements
- Help debug by asking guiding questions rather than providing fixes
- Explain error messages and what they mean
- Suggest approaches or algorithms at a high level
- Provide small code examples (2-5 lines) to illustrate a specific concept
- Encourage exploration and experimentation

## What You SHOULD NOT Do:
- Write entire functions or complete implementations
- Generate full solutions to problems
- Refactor large portions of code
- Write more than 5 lines of code at once
- Convert requirements directly into working code
- Do the work for the student

## Teaching Approach:
1. Ask clarifying questions to understand what they've tried
2. Reference concepts and documentation rather than giving direct answers
3. Suggest next steps instead of implementing them
4. Review their code and point out specific areas for improvement
5. Explain the "why" behind suggestions, not just the "how"

## Code Examples:
If providing code:
- Keep it minimal (2-5 lines max)
- Focus on illustrating a single concept
- Use different variable names than their code
- Explain each line's purpose
- Encourage adaptation, not copying

Remember: The goal is for students to learn by doing, not by watching you generate solutions.`,
        display: false,
      },
    };
  });

  // Track learning progress after each turn
  pi.on("turn_end", async (event, ctx) => {
    if (!teachModeEnabled) return;
    if (!isAssistantMessage(event.message)) return;

    const text = getTextContent(event.message);

    // Extract learning objectives from response
    const newObjectives = extractLearningObjectives(text);
    for (const obj of newObjectives) {
      if (!learningObjectives.some((o) => o.text === obj.text)) {
        learningObjectives.push(obj);
      }
    }

    markMasteredObjectives(text, learningObjectives);

    if (quizMode) {
      const quizMarkers = text.match(/\[QUIZ:(\d+):(CORRECT|INCORRECT)\]/g);
      if (quizMarkers) {
        for (const marker of quizMarkers) {
          const match = marker.match(/\[QUIZ:(\d+):(CORRECT|INCORRECT)\]/);
          if (match) {
            const index = Number.parseInt(match[1], 10) - 1;
            if (currentQuiz[index]) {
              currentQuiz[index].answered = true;
              currentQuiz[index].correct = match[2] === "CORRECT";
            }
          }
        }
      }
    }

    updateStatus(ctx);
    persistState();
  });

  // Handle end of teaching session
  pi.on("agent_end", async (event, ctx) => {
    if (!teachModeEnabled) return;

    if (quizMode && currentQuiz.length > 0 && currentQuiz.every((q) => q.answered)) {
      const correct = currentQuiz.filter((q) => q.correct).length;
      const total = currentQuiz.length;
      const percentage = Math.round((correct / total) * 100);

      pi.sendMessage(
        {
          customType: "quiz-complete",
          content: `**Quiz Complete!** 🎉\n\nScore: ${correct}/${total} (${percentage}%)\n\n${
            percentage >= 80
              ? "Great job! You've mastered these concepts!"
              : "Keep practicing! Review the concepts you missed."
          }`,
          display: true,
        },
        { triggerTurn: false },
      );

      quizMode = false;
      currentQuiz = [];
      updateStatus(ctx);
      persistState();
      return;
    }

    // Extract quiz questions if teaching ended with them
    const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
    if (lastAssistant) {
      const extracted = extractQuizQuestions(getTextContent(lastAssistant));
      if (extracted.length > 0) {
        currentQuiz = extracted;
      }
    }

    persistState();

    if (!ctx.hasUI || learningObjectives.length === 0) return;

    const choice = await ctx.ui.select("What would you like to do next?", [
      "Continue learning",
      "Take a quiz",
      "Review objectives",
      "Exit teach mode",
    ]);

    if (choice === "Take a quiz") {
      quizMode = true;
      updateStatus(ctx);
      persistState();
      pi.sendUserMessage("Quiz me on what we just covered");
    } else if (choice === "Review objectives") {
      const list = learningObjectives
        .map((obj, i) => `${i + 1}. ${obj.mastered ? "✓" : "○"} ${obj.text}`)
        .join("\n");
      pi.sendMessage(
        {
          customType: "objectives-review",
          content: `**Learning Objectives:**\n\n${list}`,
          display: true,
        },
        { triggerTurn: false },
      );
    } else if (choice === "Exit teach mode") {
      toggleTeachMode(ctx);
    }
  });

  // Restore state on session start/resume
  pi.on("session_start", async (_event, ctx) => {
    if (pi.getFlag("teach") === true) {
      teachModeEnabled = true;
    }

    const entries = ctx.sessionManager.getEntries();

    // Restore persisted state
    const teachEntry = entries
      .filter(
        (e: { type: string; customType?: string }) =>
          e.type === "custom" && e.customType === "teach-mode",
      )
      .pop() as
      | {
          data?: {
            enabled: boolean;
            objectives?: LearningObjective[];
            quiz?: QuizQuestion[];
            quizMode?: boolean;
          };
        }
      | undefined;

    if (teachEntry?.data) {
      teachModeEnabled = teachEntry.data.enabled ?? teachModeEnabled;
      learningObjectives = teachEntry.data.objectives ?? learningObjectives;
      currentQuiz = teachEntry.data.quiz ?? currentQuiz;
      quizMode = teachEntry.data.quizMode ?? quizMode;
    }

    if (teachModeEnabled) {
      activateTools(TEACH_MODE_TOOLS);
    }
    updateStatus(ctx);
  });

  // Filter out stale teach mode context when not in teach mode
  pi.on("context", async (event) => {
    if (teachModeEnabled) return;

    return {
      messages: event.messages.filter((m) => {
        const msg = m as AgentMessage & { customType?: string };
        if (msg.customType === "teach-mode-context") return false;
        if (msg.customType === "teach-quiz-context") return false;
        if (msg.role !== "user") return true;

        const content = msg.content;
        if (typeof content === "string") {
          return !content.includes("[TEACH MODE ACTIVE]");
        }
        if (Array.isArray(content)) {
          return !content.some(
            (c) => c.type === "text" && (c as TextContent).text?.includes("[TEACH MODE ACTIVE]"),
          );
        }
        return true;
      }),
    };
  });
}
