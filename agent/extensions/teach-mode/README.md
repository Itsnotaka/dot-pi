# Teach Mode Extension

An educational mode for Pi that transforms it into a teaching assistant rather than a code generator, inspired by [Carson Gross's teaching philosophy](https://gist.github.com/1cg/a6c6f2276a1fe5ee172282580a44a7ac).

## Philosophy

In teach mode, Pi helps you **learn by doing**, not by watching it solve problems for you. It focuses on:

- **Explanation over implementation** - Understand the "why" behind solutions
- **Guided discovery** - Learn through questions and exploration
- **Small examples** - Illustrate concepts with 2-5 line code snippets
- **Feedback, not fixes** - Review your code and suggest improvements

## Features

### 🎓 Teaching Assistant Mode

- Toggle with `/teach` command or `Ctrl+Alt+T`
- Restricts tools to read-only operations (read, grep, find, ls, bash, questionnaire)
- Blocks direct code generation requests with helpful redirection
- Encourages asking "How does X work?" instead of "Write X for me"

### 📋 Learning Objectives

- Automatically extracts learning objectives from responses
- Tracks mastery progress
- Shows objectives widget in the UI
- Use `/objectives` to review current learning goals

### 📝 Quiz Mode

- Test your understanding of concepts
- Start with `/quiz` command
- Tracks answers and provides feedback
- Shows completion score with percentage

### 💾 State Persistence

- Remembers your learning objectives across sessions
- Restores quiz progress if interrupted
- Maintains teach mode state between sessions

## Commands

- `/teach` - Toggle teach mode on/off
- `/objectives` - Show current learning objectives
- `/quiz` - Start a quiz on recent concepts

## Shortcuts

- `Ctrl+Alt+T` - Toggle teach mode

## Usage Examples

### ❌ Bad (Direct code generation)

```
User: "Write a function to sort an array"
Pi: 🎓 In teach mode, I help you learn by explaining concepts...
```

### ✅ Good (Learning-focused)

````
User: "How does quicksort work?"
Pi: Quicksort is a divide-and-conquer algorithm that works by...

    Here's a minimal example of the partition step:
    ```python
    pivot = arr[high]
    i = low - 1
    # ... (explanation of each line)
    ```

    Now try implementing it yourself! What part would you like to tackle first?
````

## What Pi SHOULD Do in Teach Mode

- ✅ Explain concepts when you're confused
- ✅ Point to relevant documentation or materials
- ✅ Review code you've written and suggest improvements
- ✅ Help debug by asking guiding questions
- ✅ Explain error messages and their meaning
- ✅ Suggest approaches or algorithms at a high level
- ✅ Provide small code examples (2-5 lines) to illustrate concepts

## What Pi SHOULD NOT Do in Teach Mode

- ❌ Write entire functions or complete implementations
- ❌ Generate full solutions to problems
- ❌ Refactor large portions of your code
- ❌ Write more than 5 lines of code at once
- ❌ Convert requirements directly into working code
- ❌ Do the work for you

## Teaching Approach

When you ask for help, Pi will:

1. **Ask clarifying questions** to understand what you've tried
2. **Reference concepts** from documentation rather than giving direct answers
3. **Suggest next steps** instead of implementing them
4. **Review your code** and point out specific areas for improvement
5. **Explain the "why"** behind suggestions, not just the "how"

## Code Examples

When Pi provides code examples in teach mode:

- Kept minimal (2-5 lines max)
- Focus on illustrating a single concept
- Use different variable names than your code
- Each line's purpose is explained
- You're encouraged to adapt, not copy

## Integration with Pi

This extension:

- Works with the existing tool system
- Integrates with the UI widget system
- Persists state through session management
- Uses the command and shortcut systems
- Hooks into the agent lifecycle events

## Inspired By

Carson Gross's [AI Agent Guidelines](https://gist.github.com/1cg/a6c6f2276a1fe5ee172282580a44a7ac) for teaching computer science at Montana State University.

> "Remember: The goal is for students to learn by doing, not by watching an AI generate solutions."
