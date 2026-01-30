# TUI Components

All from `@mariozechner/pi-tui`. Used in `renderCall`, `renderResult`, `setWidget` callbacks, and `ctx.ui.custom()`.

## Component Base

Every component extends `Component`:
```typescript
class Component {
  render(width: number): string[];  // Returns array of lines
  invalidate(): void;               // Marks dirty for re-render
  get height(): number;             // Computed from last render
}
```

Rendering is line-based. `render(width)` returns `string[]` where each string is one terminal line with ANSI codes.

## Core Components

### Text
```typescript
import { Text } from "@mariozechner/pi-tui";
new Text(content: string, paddingTop: number, paddingBottom: number);
```
Multi-line via `\n` in content. Supports ANSI (use `theme.fg()`, `theme.bold()`).

### Container
```typescript
import { Container } from "@mariozechner/pi-tui";
const c = new Container();
c.addChild(component);
c.removeChild(component);
c.clear();
```
Vertical stack. Renders children top-to-bottom.

### Spacer
```typescript
import { Spacer } from "@mariozechner/pi-tui";
new Spacer(lines: number);
```
Empty vertical space.

### Box
```typescript
import { Box } from "@mariozechner/pi-tui";
new Box(child: Component, options: BoxOptions);
// BoxOptions: { padding?, background?, border? }
```
Wraps a component with padding/background. Tool results are auto-wrapped in Box.

### Markdown
```typescript
import { Markdown } from "@mariozechner/pi-tui";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
new Markdown(text: string, paddingTop: number, paddingBottom: number, getMarkdownTheme());
```
Renders markdown with syntax highlighting, headers, lists, code blocks.

### SelectList
```typescript
import { SelectList } from "@mariozechner/pi-tui";
// Used internally for /model, /resume, etc. Available for custom UIs.
```

### BorderedLoader
For async operations with a cancel option.

## Theme Colors

```typescript
theme.fg("toolTitle", text)   // Tool names
theme.fg("accent", text)      // Highlights, section headers
theme.fg("success", text)     // Green (✓)
theme.fg("error", text)       // Red (✗)
theme.fg("warning", text)     // Yellow (⏳)
theme.fg("muted", text)       // Secondary text
theme.fg("dim", text)         // Tertiary text, file paths
theme.fg("mdHeading", text)   // [Section] headers on startup
theme.fg("mdLink", text)      // Links, package sources
theme.fg("toolOutput", text)  // Tool output text
theme.bold(text)
theme.italic(text)
theme.strikethrough(text)
```

Syntax highlighting:
```typescript
import { highlightCode, getLanguageFromPath } from "@mariozechner/pi-coding-agent";
const lang = getLanguageFromPath("file.rs");  // "rust"
highlightCode(code, lang, theme);
```

## ctx.ui Methods

### Dialogs (blocking)
```typescript
await ctx.ui.select("Title:", ["A", "B", "C"]);         // returns string | undefined
await ctx.ui.confirm("Title", "Description");             // returns boolean
await ctx.ui.input("Label:", "placeholder");               // returns string | undefined
await ctx.ui.editor("Label:", "prefilled");                // returns string | undefined
// All support { timeout: 5000 } or { signal: AbortSignal }
```

### Persistent UI
```typescript
ctx.ui.setWidget("id", ["line1", "line2"]);                              // string array
ctx.ui.setWidget("id", ["line1"], { placement: "belowEditor" });         // below editor
ctx.ui.setWidget("id", (tui, theme) => new Text("...", 0, 0));           // callback form
ctx.ui.setWidget("id", undefined);                                        // clear

ctx.ui.setStatus("id", "text");     // footer status
ctx.ui.setStatus("id", undefined);  // clear

ctx.ui.setWorkingMessage("Thinking deeply...");  // during streaming
ctx.ui.setWorkingMessage();                       // restore default

ctx.ui.notify("message", "info");   // "info" | "warning" | "error"
ctx.ui.setTitle("window title");
ctx.ui.setEditorText("prefill");
```

### Custom Components
```typescript
const result = await ctx.ui.custom<T>((tui, theme, keybindings, done) => {
  const comp = new Text("Press Enter", 1, 1);
  comp.onKey = (key) => {
    if (key === "return") done(value);
    if (key === "escape") done(null);
    return true;
  };
  return comp;
});
// Overlay mode: ctx.ui.custom(fn, { overlay: true })
```

## Startup Screen Pattern

Pi's startup uses `theme.fg("mdHeading", "[Section]")` for headers, `theme.fg("accent", scope)` at 2-space indent, `theme.fg("dim", item)` at 4-space indent.

```typescript
ctx.ui.setWidget("id", (_tui, theme) => {
  const header = theme.fg("mdHeading", "[MySection]");
  const items = data.map(d => `    ${theme.fg("dim", d.label)}`);
  return new Text(`${header}\n${items.join("\n")}`, 0, 0);
});
```
