import { describe, it, expect } from "vitest";
import {
  isCodeGenerationRequest,
  extractLearningObjectives,
  extractQuizQuestions,
  cleanObjectiveText,
  markMasteredObjectives,
} from "./utils.js";

describe("isCodeGenerationRequest", () => {
  it("should detect direct code generation requests", () => {
    expect(isCodeGenerationRequest("Write a function to sort an array")).toBe(true);
    expect(isCodeGenerationRequest("Create a React component for login")).toBe(true);
    expect(isCodeGenerationRequest("Build me an API endpoint")).toBe(true);
    expect(isCodeGenerationRequest("Implement the quicksort algorithm")).toBe(true);
    expect(isCodeGenerationRequest("Generate a solution for this problem")).toBe(true);
    expect(isCodeGenerationRequest("Can you write code for authentication?")).toBe(true);
    expect(isCodeGenerationRequest("Complete this function for me")).toBe(true);
    expect(isCodeGenerationRequest("Fill in the TODO sections")).toBe(true);
  });

  it("should allow learning-focused requests", () => {
    expect(isCodeGenerationRequest("How does quicksort work?")).toBe(false);
    expect(isCodeGenerationRequest("What is a closure in JavaScript?")).toBe(false);
    expect(isCodeGenerationRequest("Explain the difference between let and const")).toBe(false);
    expect(isCodeGenerationRequest("Can you help me understand pointers?")).toBe(false);
    expect(isCodeGenerationRequest("Why is my code not working?")).toBe(false);
    expect(isCodeGenerationRequest("Review my implementation of binary search")).toBe(false);
    expect(isCodeGenerationRequest("Check my code for errors")).toBe(false);
    expect(isCodeGenerationRequest("I need to understand recursion better")).toBe(false);
  });
});

describe("cleanObjectiveText", () => {
  it("should remove markdown formatting and prefixes", () => {
    expect(cleanObjectiveText("**Understanding closures**")).toBe("Closures");
    expect(cleanObjectiveText("*Learn* about `async/await`")).toBe("About async/await");
  });

  it("should remove common prefixes", () => {
    expect(cleanObjectiveText("Understand how recursion works")).toBe("How recursion works");
    expect(cleanObjectiveText("Learn the basics of CSS")).toBe("The basics of CSS");
  });

  it("should truncate long text", () => {
    const longText = "This is a very long learning objective that should be truncated to fit";
    const result = cleanObjectiveText(longText);
    expect(result.length).toBeLessThanOrEqual(60);
    expect(result.endsWith("...")).toBe(true);
  });

  it("should capitalize first letter after removing prefixes", () => {
    expect(cleanObjectiveText("understanding variables")).toBe("Variables");
  });
});

describe("extractLearningObjectives", () => {
  it("should extract objectives from numbered list", () => {
    const message = `
**Learning Objectives:**

1. Understanding closures in JavaScript
2. Learn about async/await patterns
3. Master error handling techniques
`;
    const objectives = extractLearningObjectives(message);
    expect(objectives).toHaveLength(3);
    expect(objectives[0].text).toContain("Closures");
    expect(objectives[0].mastered).toBe(false);
  });

  it("should handle different header formats", () => {
    const messages = [
      "**You'll learn:**\n1. React hooks",
      "Goals:\n1. TypeScript basics",
      "Key Concepts:\n1. Design patterns",
    ];

    for (const msg of messages) {
      const objectives = extractLearningObjectives(msg);
      expect(objectives.length).toBeGreaterThan(0);
    }
  });

  it("should return empty array when no objectives found", () => {
    const message = "This is just a regular response without objectives.";
    const objectives = extractLearningObjectives(message);
    expect(objectives).toHaveLength(0);
  });
});

describe("extractQuizQuestions", () => {
  it("should extract quiz questions", () => {
    const message = `
**Quiz:**

1. What is a closure?
2. How does event bubbling work?
3. What's the difference between let and const?
`;
    const questions = extractQuizQuestions(message);
    expect(questions).toHaveLength(3);
    expect(questions[0].question).toContain("closure");
    expect(questions[0].answered).toBe(false);
  });

  it("should only extract questions with question marks", () => {
    const message = `
**Questions:**

1. What is a variable?
2. This is not a question
3. How does this work?
`;
    const questions = extractQuizQuestions(message);
    expect(questions).toHaveLength(2);
    expect(questions.every((q) => q.question.includes("?"))).toBe(true);
  });

  it("should handle different quiz header formats", () => {
    const messages = [
      "**Quiz:**\n\n1. What is X?",
      "Questions:\n\n1. How does Y work?",
      "Test Your Understanding:\n\n1. Why is Z important?",
    ];

    for (const msg of messages) {
      const questions = extractQuizQuestions(msg);
      expect(questions.length).toBeGreaterThan(0);
    }
  });

  it("should accept concise but valid quiz questions", () => {
    const message = "**Quiz:**\n\n1. What is X?";
    const questions = extractQuizQuestions(message);
    expect(questions).toHaveLength(1);
    expect(questions[0].question).toBe("What is X?");
  });
});

describe("markMasteredObjectives", () => {
  it("should mark objectives as mastered", () => {
    const objectives = [
      { text: "Closures in JavaScript", mastered: false },
      { text: "Async/await patterns", mastered: false },
      { text: "Error handling", mastered: false },
    ];

    const message = "Great job! [MASTERED:closures] You now understand closures well.";
    const count = markMasteredObjectives(message, objectives);

    expect(count).toBe(1);
    expect(objectives[0].mastered).toBe(true);
    expect(objectives[1].mastered).toBe(false);
  });

  it("should handle partial matches", () => {
    const objectives = [{ text: "Understanding React Hooks", mastered: false }];

    const message = "[MASTERED:hooks] You've got it!";
    const count = markMasteredObjectives(message, objectives);

    expect(count).toBe(1);
    expect(objectives[0].mastered).toBe(true);
  });

  it("should not mark already mastered objectives", () => {
    const objectives = [{ text: "Closures", mastered: true }];

    const message = "[MASTERED:closures]";
    const count = markMasteredObjectives(message, objectives);

    expect(count).toBe(0);
  });
});
