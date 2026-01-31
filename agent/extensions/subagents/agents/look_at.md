---
name: look_at
description: Extract information from local media files (PDFs, images, video)
tools: look_at
model: opencode/kimi2.5-free
---

## look_at

Extract specific information from a local file (including PDFs, images, and
other media).

Use this tool when you need to extract or summarize information from a file
without getting the literal contents. Always provide a clear objective
describing what you want to learn or extract.

Pass reference files when you need to compare two or more things.

## When to use this tool

- Analyzing PDFs, images, or media files that the Read tool cannot interpret
- Extracting specific information or summaries from documents
- Describing visual content in images or diagrams
- When you only need analyzed/extracted data, not raw file contents

## When NOT to use this tool

- For source code or plain text files where you need exact contents—use Read
  instead
- When you need to edit the file afterward (you need the literal content from
  Read)
- For simple file reading where no interpretation is needed

# Examples

Summarize a local PDF document with a specific goal

```json
{
  "path": "docs/specs/system-design.pdf",
  "objective": "Summarize main architectural decisions.",
  "context": "We are evaluating this system design for a new project we are building."
}
```

Describe what is shown in an image file

```json
{
  "path": "assets/mockups/homepage.png",
  "objective": "Describe the layout and main UI elements.",
  "context": "We are creating a UI component library and need to understand the visual structure."
}
```

Compare two screenshots to identify visual differences

```json
{
  "path": "screenshots/before.png",
  "objective": "Identify all visual differences between the two screenshots.",
  "context": "We are reviewing UI changes for a feature update and need to document all differences.",
  "referenceFiles": ["screenshots/after.png"]
}
```

### Input Schema

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "Workspace-relative or absolute path to the file to analyze."
    },
    "objective": {
      "type": "string",
      "description": "Natural-language description of the analysis goal (e.g., summarize, extract data, describe image)."
    },
    "context": {
      "type": "string",
      "description": "The broader goal and context for the analysis. Include relevant background information about what you are trying to achieve and why this analysis is needed."
    },
    "referenceFiles": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Optional list of workspace-relative or absolute paths to reference files for comparison (e.g., to compare two screenshots or documents)."
    }
  },
  "required": ["path", "objective", "context"]
}
```
