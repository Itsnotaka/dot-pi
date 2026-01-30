/**
 * Clean statusline extension inspired by Amp's minimal design
 *
 * Replaces default footer with essential context:
 * - Active tool/operation
 * - Context usage % (color-coded by threshold)
 * - Current folder name
 * - Git branch
 * - Model name
 *
 * Colors adapt based on state:
 * - Context: green → yellow → red as usage increases
 * - Operations: accent for active, dim for idle
 * - Location: muted to stay out of the way
 *
 * Toggle with: /statusline
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

export default function (pi: ExtensionAPI) {
  let enabled = true;

  const filesChanged = new Set<string>();
  let diffStats = { added: 0, changed: 0, deleted: 0 };

  pi.registerCommand("statusline", {
    description: "Toggle clean statusline",
    handler: async (_args, ctx) => {
      enabled = !enabled;

      if (enabled) {
        setupFooter(ctx);
        ctx.ui.notify("Clean statusline enabled", "info");
      } else {
        ctx.ui.setFooter(undefined);
        ctx.ui.notify("Default footer restored", "info");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    filesChanged.clear();
    diffStats = { added: 0, changed: 0, deleted: 0 };
    if (enabled) setupFooter(ctx);
  });

  pi.on("tool_call", async (event, _ctx) => {
    trackFileChanges(event);
  });

  function trackFileChanges(event: ToolCallEvent) {
    const { toolName, input } = event;

    if (toolName === "edit_file" && typeof input.path === "string") {
      filesChanged.add(input.path);

      if (
        typeof input.old_str === "string" &&
        typeof input.new_str === "string"
      ) {
        const oldLines = input.old_str.split("\n").length;
        const newLines = input.new_str.split("\n").length;
        const diff = newLines - oldLines;

        if (diff > 0) diffStats.added += diff;
        else if (diff < 0) diffStats.deleted += Math.abs(diff);
        else diffStats.changed++;
      }
    } else if (
      (toolName === "create_file" || toolName === "write_file") &&
      typeof input.path === "string"
    ) {
      filesChanged.add(input.path);

      if (typeof input.content === "string") {
        const lines = input.content.split("\n").length;
        diffStats.added += lines;
      }
    }
  }

  function setupFooter(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;

    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsub = footerData.onBranchChange(() => tui.requestRender());

      return {
        dispose: unsub,
        invalidate() {},
        render(width: number): string[] {
          const leftParts: string[] = [];
          const rightParts: string[] = [];

          const usage = ctx.getContextUsage();
          if (usage) {
            const percent = usage.percent;
            let color: "success" | "error" | "warning" = "success";
            if (percent > 90) color = "error";
            else if (percent > 75) color = "warning";

            const formatTokens = (n: number) =>
              n < 1000 ? `${n}` : `${(n / 1000).toFixed(0)}k`;
            const contextStr =
              theme.fg(color, `${percent.toFixed(0)}%`) +
              theme.fg("dim", ` of ${formatTokens(usage.contextWindow)}`);
            leftParts.push(contextStr);
          }

          const model = ctx.model?.id || "no-model";
          const thinkingLevel = pi.getThinkingLevel();

          if (thinkingLevel && thinkingLevel !== "off") {
            const thinkingColorMap: Record<
              string,
              | "thinkingMinimal"
              | "thinkingLow"
              | "thinkingMedium"
              | "thinkingHigh"
              | "thinkingXhigh"
            > = {
              minimal: "thinkingMinimal",
              low: "thinkingLow",
              medium: "thinkingMedium",
              high: "thinkingHigh",
              xhigh: "thinkingXhigh",
            };
            const thinkingColor =
              thinkingColorMap[thinkingLevel] || "thinkingText";
            rightParts.push(
              theme.fg(thinkingColor, `${model} (${thinkingLevel})`)
            );
          } else {
            rightParts.push(theme.fg("toolTitle", model));
          }

          const home = process.env.HOME || "";
          const cwd = process.cwd();
          const displayPath =
            home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;

          const branch = footerData.getGitBranch();
          const pathWithBranch =
            branch && branch !== "detached"
              ? `${displayPath} ${theme.fg("muted", `(${branch})`)}`
              : displayPath;
          rightParts.push(theme.fg("dim", pathWithBranch));

          const left = leftParts.join(theme.fg("dim", " · "));
          const right = rightParts.join(theme.fg("dim", " · "));
          const gap = " ".repeat(
            Math.max(1, width - visibleWidth(left) - visibleWidth(right) - 2)
          );

          const lines = [truncateToWidth(` ${left}${gap}${right} `, width)];

          if (filesChanged.size > 0) {
            const fileCount = theme.fg(
              "dim",
              `${filesChanged.size} file${filesChanged.size === 1 ? "" : "s"}`
            );
            const stats = [
              diffStats.added > 0
                ? theme.fg("success", `+${diffStats.added}`)
                : null,
              diffStats.changed > 0
                ? theme.fg("warning", `~${diffStats.changed}`)
                : null,
              diffStats.deleted > 0
                ? theme.fg("error", `-${diffStats.deleted}`)
                : null,
            ]
              .filter(Boolean)
              .join(" ");

            const secondLine = ` ${fileCount}${stats ? " " + stats : ""}`;
            lines.push(truncateToWidth(secondLine, width));
          }

          return lines;
        },
      };
    });
  }
}
