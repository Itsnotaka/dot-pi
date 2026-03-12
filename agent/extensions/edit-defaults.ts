import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { Type } from "@sinclair/typebox";
import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve as resolvePath } from "node:path";

const editSchema = Type.Object({
  path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
  oldText: Type.Optional(Type.String({ description: "Exact text to find and replace" })),
  newText: Type.Optional(Type.String({ description: "Replacement text" })),
  old_text: Type.Optional(
    Type.String({ description: "Exact text to find and replace (snake_case alias)" }),
  ),
  new_text: Type.Optional(Type.String({ description: "Replacement text (snake_case alias)" })),
  all: Type.Optional(
    Type.Boolean({ description: "Replace all occurrences instead of requiring uniqueness" }),
  ),
});

type EditParams = {
  path: string;
  oldText?: string;
  newText?: string;
  old_text?: string;
  new_text?: string;
  all?: boolean;
};

type FuzzyMatchResult = {
  found: boolean;
  index: number;
  matchLength: number;
  usedFuzzyMatch: boolean;
  contentForReplacement: string;
};

function detectLineEnding(content: string): "\n" | "\r\n" {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");

  if (lfIdx === -1) {
    return "\n";
  }

  if (crlfIdx === -1) {
    return "\n";
  }

  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

function normalizeToLf(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function restoreLineEndings(text: string, ending: "\n" | "\r\n"): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

function normalizeForFuzzyMatch(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
  const exactIndex = content.indexOf(oldText);
  if (exactIndex !== -1) {
    return {
      found: true,
      index: exactIndex,
      matchLength: oldText.length,
      usedFuzzyMatch: false,
      contentForReplacement: content,
    };
  }

  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);

  if (fuzzyIndex === -1) {
    return {
      found: false,
      index: -1,
      matchLength: 0,
      usedFuzzyMatch: false,
      contentForReplacement: content,
    };
  }

  return {
    found: true,
    index: fuzzyIndex,
    matchLength: fuzzyOldText.length,
    usedFuzzyMatch: true,
    contentForReplacement: fuzzyContent,
  };
}

function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF")
    ? { bom: "\uFEFF", text: content.slice(1) }
    : { bom: "", text: content };
}

function expandPath(filePath: string): string {
  if (filePath === "~") {
    return homedir();
  }

  if (filePath.startsWith("~/")) {
    return homedir() + filePath.slice(1);
  }

  return filePath;
}

function resolveToCwd(filePath: string, cwd: string): string {
  const expanded = expandPath(filePath.startsWith("@") ? filePath.slice(1) : filePath);
  if (isAbsolute(expanded)) {
    return expanded;
  }
  return resolvePath(cwd, expanded);
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("Operation aborted");
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "edit",
    label: "edit",
    description:
      "Edit a file by replacing text with fuzzy matching and optional all-occurrences mode. Supports both oldText/newText and old_text/new_text.",
    parameters: editSchema,
    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      assertNotAborted(signal);

      const params = rawParams as EditParams;
      const { path, all = false } = params;
      const oldText = params.oldText ?? params.old_text;
      const newText = params.newText ?? params.new_text;

      if (!oldText || newText === undefined) {
        throw new Error("Missing edit parameters. Provide oldText/newText (or old_text/new_text).");
      }

      if (oldText.length === 0) {
        throw new Error("oldText must not be empty.");
      }

      const absolutePath = resolveToCwd(path, ctx.cwd);

      await access(absolutePath, constants.R_OK | constants.W_OK);
      assertNotAborted(signal);

      const rawContent = await readFile(absolutePath, "utf-8");
      assertNotAborted(signal);

      const { bom, text: content } = stripBom(rawContent);
      const originalEnding = detectLineEnding(content);
      const normalizedContent = normalizeToLf(content);
      const normalizedOldText = normalizeToLf(oldText);
      const normalizedNewText = normalizeToLf(newText);

      let baseContent = normalizedContent;
      let nextContent = normalizedContent;
      let replacementCount = 0;
      let usedFuzzyMatch = false;

      if (all) {
        const exactOccurrences = normalizedContent.split(normalizedOldText).length - 1;

        if (exactOccurrences > 0) {
          replacementCount = exactOccurrences;
          nextContent = normalizedContent.split(normalizedOldText).join(normalizedNewText);
        } else {
          const fuzzyContent = normalizeForFuzzyMatch(normalizedContent);
          const fuzzyOldText = normalizeForFuzzyMatch(normalizedOldText);
          const fuzzyOccurrences = fuzzyContent.split(fuzzyOldText).length - 1;

          if (fuzzyOccurrences === 0) {
            throw new Error(
              `Could not find the text in ${path}. Provide a more precise oldText block from a fresh read.`,
            );
          }

          baseContent = fuzzyContent;
          replacementCount = fuzzyOccurrences;
          usedFuzzyMatch = true;
          nextContent = fuzzyContent.split(fuzzyOldText).join(normalizedNewText);
        }
      } else {
        const matchResult = fuzzyFindText(normalizedContent, normalizedOldText);

        if (!matchResult.found) {
          throw new Error(
            `Could not find the exact text in ${path}. The old text must match exactly including whitespace and newlines.`,
          );
        }

        const fuzzyContent = normalizeForFuzzyMatch(normalizedContent);
        const fuzzyOldText = normalizeForFuzzyMatch(normalizedOldText);
        const occurrences = fuzzyContent.split(fuzzyOldText).length - 1;

        if (occurrences > 1) {
          throw new Error(
            `Found ${occurrences} occurrences in ${path}. Provide more surrounding context or set all=true if every occurrence should change.`,
          );
        }

        baseContent = matchResult.contentForReplacement;
        usedFuzzyMatch = matchResult.usedFuzzyMatch;
        replacementCount = 1;
        nextContent =
          baseContent.substring(0, matchResult.index) +
          normalizedNewText +
          baseContent.substring(matchResult.index + matchResult.matchLength);
      }

      if (baseContent === nextContent) {
        throw new Error(`No changes made to ${path}. The replacement produced identical content.`);
      }

      const finalContent = bom + restoreLineEndings(nextContent, originalEnding);
      await writeFile(absolutePath, finalContent, "utf-8");

      const note = all
        ? `Successfully replaced ${replacementCount} occurrence${replacementCount === 1 ? "" : "s"} in ${path}.`
        : `Successfully replaced text in ${path}.`;

      const fuzzyNote = usedFuzzyMatch ? " Used fuzzy matching." : "";

      return {
        content: [{ type: "text", text: `${note}${fuzzyNote}` }],
        details: {
          replacements: replacementCount,
          all,
          fuzzy: usedFuzzyMatch,
        },
      };
    },
  });
}
