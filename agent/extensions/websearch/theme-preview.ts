import { Text } from "@mariozechner/pi-tui";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("theme-preview", {
    description: "Preview styled lines for websearch output",
    async execute(ctx) {
      const theme = ctx.theme;
      const lines = [
        theme.fg("success", "✓") + " " + theme.fg("toolTitle", "Web Page ") + theme.fg("accent", "https://example.com") +
          " " + theme.fg("muted", "Read extension docs"),
        theme.fg("success", "✓") + " " + theme.fg("toolTitle", "Switching to raw file URL"),
        theme.fg("success", "✓") + " " + theme.fg("toolTitle", "Planning repo extension addition") + " " +
          theme.fg("muted", "▶"),
      ];
      const text = lines.join("\n");
      ctx.ui.custom({
        component: new Text(text, 0, 0),
      });
      return { content: [{ type: "text", text: "Preview rendered." }] };
    },
  });
}
