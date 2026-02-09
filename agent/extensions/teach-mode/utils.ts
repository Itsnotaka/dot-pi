/**
 * Pure utility functions for teach mode.
 * Extracted for testability.
 */

export interface LearningObjective {
  text: string;
  mastered: boolean;
}

export interface QuizQuestion {
  question: string;
  answered: boolean;
  correct?: boolean;
}

// Patterns that indicate code generation requests
const CODE_GENERATION_PATTERNS = [
  /^(write|create|build|implement|generate|make|code)\s+(a|an|the|my)?\s*(function|class|component|script|program|app|endpoint)/i,
  /^(can you|could you|please)\s+(write|create|build|implement|generate|code)/i,
  /^implement\b/i,
  /write.*code.*for me/i,
  /implement.*for me/i,
  /create.*implementation/i,
  /create.*component/i,
  /generate.*solution/i,
  /^build (me )?a/i,
  /complete (this|the) (function|code|implementation)/i,
  /finish (this|the) (function|code)/i,
  /fill in.*todo/i,
];

// Patterns that indicate learning/understanding requests (allowed)
const LEARNING_PATTERNS = [
  /^(how|what|why|when|where)\s/i,
  /^(can you )?explain/i,
  /^(can you )?help me understand/i,
  /^(i need|i want) (to understand|to learn|help with)/i,
  /what does.*mean/i,
  /how does.*work/i,
  /can you (teach|show) me/i,
  /^review (my|this)/i,
  /^(check|look at) (my|this)/i,
];

export function isCodeGenerationRequest(message: string): boolean {
  const lowerMessage = message.toLowerCase().trim();

  // First check if it's explicitly a learning request
  if (LEARNING_PATTERNS.some((p) => p.test(lowerMessage))) {
    return false;
  }

  // Then check if it matches code generation patterns
  return CODE_GENERATION_PATTERNS.some((p) => p.test(lowerMessage));
}

export function cleanObjectiveText(text: string): string {
  let cleaned = text
    .replace(/\*+/g, "") // Remove all asterisks (bold/italic markers)
    .replace(/`([^`]+)`/g, "$1") // Remove code formatting
    .replace(/^(Understand(?:ing)?|Learn(?:ing)?|Know(?:ing)?|Master(?:ing)?)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length > 0) {
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }
  if (cleaned.length > 60) {
    cleaned = `${cleaned.slice(0, 57)}...`;
  }
  return cleaned;
}

export function extractLearningObjectives(message: string): LearningObjective[] {
  const objectives: LearningObjective[] = [];

  // Look for "Learning Objectives:" or "You'll learn:" sections
  const headerPatterns = [
    /\*{0,2}Learning Objectives?:\*{0,2}\s*\n/i,
    /\*{0,2}You'?ll learn:\*{0,2}\s*\n/i,
    /\*{0,2}Goals?:\*{0,2}\s*\n/i,
    /\*{0,2}Key Concepts?:\*{0,2}\s*\n/i,
  ];

  for (const pattern of headerPatterns) {
    const headerMatch = message.match(pattern);
    if (!headerMatch) continue;

    const section = message.slice(message.indexOf(headerMatch[0]) + headerMatch[0].length);
    const numberedPattern = /^\s*(\d+)[.)]\s+\*{0,2}([^*\n]+)/gm;

    for (const match of section.matchAll(numberedPattern)) {
      const text = match[2]
        .trim()
        .replace(/\*{1,2}$/, "")
        .trim();

      if (text.length > 5 && !text.startsWith("`") && !text.startsWith("/")) {
        const cleaned = cleanObjectiveText(text);
        if (cleaned.length > 3) {
          objectives.push({ text: cleaned, mastered: false });
        }
      }
    }

    // If we found objectives, break
    if (objectives.length > 0) break;
  }

  return objectives;
}

export function extractQuizQuestions(message: string): QuizQuestion[] {
  const questions: QuizQuestion[] = [];

  // Look for "Quiz:" or "Questions:" sections
  const headerPatterns = [
    /\*{0,2}Quiz:\*{0,2}\s*\n/i,
    /\*{0,2}Questions?:\*{0,2}\s*\n/i,
    /\*{0,2}Test Your Understanding:\*{0,2}\s*\n/i,
  ];

  for (const pattern of headerPatterns) {
    const headerMatch = message.match(pattern);
    if (!headerMatch) continue;

    const section = message.slice(message.indexOf(headerMatch[0]) + headerMatch[0].length);
    const questionPattern = /^\s*(\d+)[.)]\s+(.+?)(?=\n|$)/gm;

    for (const match of section.matchAll(questionPattern)) {
      const question = match[2].trim();
      if (question.includes("?") && question.length >= 10) {
        questions.push({ question, answered: false });
      }
    }

    // If we found questions, break
    if (questions.length > 0) break;
  }

  return questions;
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function markMasteredObjectives(text: string, objectives: LearningObjective[]): number {
  const masteryPattern = /\[MASTERED:([^\]]+)\]/gi;
  let count = 0;

  for (const match of text.matchAll(masteryPattern)) {
    const normalizedMarker = normalizeText(match[1]);
    if (!normalizedMarker) continue;

    const exact = objectives.find((obj) => normalizeText(obj.text) === normalizedMarker);
    if (exact && !exact.mastered) {
      exact.mastered = true;
      count++;
      continue;
    }

    const matches = objectives.filter((obj) => {
      const normalizedObjective = normalizeText(obj.text);
      return (
        normalizedObjective.includes(normalizedMarker) ||
        normalizedMarker.includes(normalizedObjective)
      );
    });

    if (matches.length === 1 && !matches[0].mastered) {
      matches[0].mastered = true;
      count++;
    }
  }

  return count;
}
