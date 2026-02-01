/**
 * Task List Extension - Manage tasks with simple status tracking.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@mariozechner/pi-coding-agent";

import { StringEnum } from "@mariozechner/pi-ai";
import { matchesKey, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

type TaskStatus = "pending" | "in_progress" | "completed";

interface TaskItem {
  id: number;
  text: string;
  status: TaskStatus;
}

interface TaskDetails {
  action: "list" | "add" | "update" | "remove" | "clear";
  tasks: TaskItem[];
  nextId: number;
  error?: string;
}

const TaskStatusSchema = StringEnum(
  ["pending", "in_progress", "completed"] as const,
  {
    description: "Task status",
    default: "pending",
  }
);

const TaskParams = Type.Object({
  action: StringEnum(["list", "add", "update", "remove", "clear"] as const),
  text: Type.Optional(
    Type.String({ description: "Task text (for add/update)" })
  ),
  id: Type.Optional(
    Type.Number({ description: "Task ID (for update/remove)" })
  ),
  status: Type.Optional(TaskStatusSchema),
});

const STATUS_LABELS: Record<TaskStatus, string> = {
  pending: "pending",
  in_progress: "in progress",
  completed: "completed",
};

function formatTaskLine(task: TaskItem): string {
  return `[#${task.id}] ${task.text} (${STATUS_LABELS[task.status]})`;
}

/**
 * UI component for the /tasks command
 */
class TaskListComponent {
  private tasks: TaskItem[];
  private theme: Theme;
  private onClose: () => void;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(tasks: TaskItem[], theme: Theme, onClose: () => void) {
    this.tasks = tasks;
    this.theme = theme;
    this.onClose = onClose;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.onClose();
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const lines: string[] = [];
    const th = this.theme;

    lines.push("");
    const title = th.fg("accent", " Tasks ");
    const headerLine =
      th.fg("borderMuted", "─".repeat(3)) +
      title +
      th.fg("borderMuted", "─".repeat(Math.max(0, width - 10)));
    lines.push(truncateToWidth(headerLine, width));
    lines.push("");

    if (this.tasks.length === 0) {
      lines.push(
        truncateToWidth(
          `  ${th.fg("dim", "No tasks yet. Ask the agent to add some!")}`,
          width
        )
      );
    } else {
      const completed = this.tasks.filter(
        (t) => t.status === "completed"
      ).length;
      const inProgress = this.tasks.filter(
        (t) => t.status === "in_progress"
      ).length;
      const total = this.tasks.length;
      lines.push(
        truncateToWidth(
          `  ${th.fg(
            "muted",
            `${completed}/${total} completed${inProgress ? ` • ${inProgress} in progress` : ""}`
          )}`,
          width
        )
      );
      lines.push("");

      for (const task of this.tasks) {
        const icon =
          task.status === "completed"
            ? th.fg("success", "✓")
            : task.status === "in_progress"
              ? th.fg("warning", "●")
              : th.fg("dim", "○");
        const id = th.fg("accent", `#${task.id}`);
        const text =
          task.status === "completed"
            ? th.fg("dim", task.text)
            : th.fg("text", task.text);
        const status =
          task.status === "in_progress"
            ? th.fg("warning", "in progress")
            : task.status === "completed"
              ? th.fg("success", "completed")
              : th.fg("muted", "pending");
        lines.push(truncateToWidth(`  ${icon} ${id} ${text} ${status}`, width));
      }
    }

    lines.push("");
    lines.push(
      truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width)
    );
    lines.push("");

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

export default function (pi: ExtensionAPI) {
  // In-memory state (reconstructed from session on load)
  let tasks: TaskItem[] = [];
  let nextId = 1;

  /**
   * Reconstruct state from session entries.
   * Scans tool results for this tool and applies them in order.
   */
  const reconstructState = (ctx: ExtensionContext) => {
    tasks = [];
    nextId = 1;

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const msg = entry.message;
      if (msg.role !== "toolResult" || msg.toolName !== "task_list") continue;

      const details = msg.details as TaskDetails | undefined;
      if (details) {
        tasks = details.tasks;
        nextId = details.nextId;
      }
    }
  };

  // Reconstruct state on session events
  pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
  pi.on("session_switch", async (_event, ctx) => reconstructState(ctx));
  pi.on("session_fork", async (_event, ctx) => reconstructState(ctx));
  pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

  // Register the task list tool for the LLM
  pi.registerTool({
    name: "task_list",
    label: "Task List",
    description:
      "Manage a task list with statuses. Actions: list, add (text), update (id, status/text), remove (id), clear",
    parameters: TaskParams,

    async execute(_toolCallId, params, _onUpdate, _ctx, _signal) {
      switch (params.action) {
        case "list":
          return {
            content: [
              {
                type: "text",
                text: tasks.length
                  ? tasks.map((t) => formatTaskLine(t)).join("\n")
                  : "No tasks",
              },
            ],
            details: {
              action: "list",
              tasks: [...tasks],
              nextId,
            } as TaskDetails,
          };

        case "add": {
          if (!params.text) {
            return {
              content: [{ type: "text", text: "Error: text required for add" }],
              details: {
                action: "add",
                tasks: [...tasks],
                nextId,
                error: "text required",
              } as TaskDetails,
            };
          }
          const status = (params.status ?? "pending") as TaskStatus;
          const newTask: TaskItem = { id: nextId++, text: params.text, status };
          tasks.push(newTask);
          return {
            content: [
              {
                type: "text",
                text: `Added task #${newTask.id}: ${newTask.text} (${STATUS_LABELS[newTask.status]})`,
              },
            ],
            details: {
              action: "add",
              tasks: [...tasks],
              nextId,
            } as TaskDetails,
          };
        }

        case "update": {
          if (params.id === undefined) {
            return {
              content: [
                { type: "text", text: "Error: id required for update" },
              ],
              details: {
                action: "update",
                tasks: [...tasks],
                nextId,
                error: "id required",
              } as TaskDetails,
            };
          }
          const task = tasks.find((t) => t.id === params.id);
          if (!task) {
            return {
              content: [{ type: "text", text: `Task #${params.id} not found` }],
              details: {
                action: "update",
                tasks: [...tasks],
                nextId,
                error: `#${params.id} not found`,
              } as TaskDetails,
            };
          }
          if (!params.text && !params.status) {
            return {
              content: [
                {
                  type: "text",
                  text: "Error: provide text and/or status for update",
                },
              ],
              details: {
                action: "update",
                tasks: [...tasks],
                nextId,
                error: "text or status required",
              } as TaskDetails,
            };
          }
          if (params.text) task.text = params.text;
          if (params.status) task.status = params.status as TaskStatus;
          return {
            content: [
              {
                type: "text",
                text: `Updated task #${task.id}: ${task.text} (${STATUS_LABELS[task.status]})`,
              },
            ],
            details: {
              action: "update",
              tasks: [...tasks],
              nextId,
            } as TaskDetails,
          };
        }

        case "remove": {
          if (params.id === undefined) {
            return {
              content: [
                { type: "text", text: "Error: id required for remove" },
              ],
              details: {
                action: "remove",
                tasks: [...tasks],
                nextId,
                error: "id required",
              } as TaskDetails,
            };
          }
          const index = tasks.findIndex((t) => t.id === params.id);
          if (index === -1) {
            return {
              content: [{ type: "text", text: `Task #${params.id} not found` }],
              details: {
                action: "remove",
                tasks: [...tasks],
                nextId,
                error: `#${params.id} not found`,
              } as TaskDetails,
            };
          }
          const [removed] = tasks.splice(index, 1);
          return {
            content: [
              {
                type: "text",
                text: `Removed task #${removed.id}: ${removed.text}`,
              },
            ],
            details: {
              action: "remove",
              tasks: [...tasks],
              nextId,
            } as TaskDetails,
          };
        }

        case "clear": {
          const count = tasks.length;
          tasks = [];
          nextId = 1;
          return {
            content: [{ type: "text", text: `Cleared ${count} tasks` }],
            details: { action: "clear", tasks: [], nextId: 1 } as TaskDetails,
          };
        }

        default: {
          const action = params.action as string;
          return {
            content: [{ type: "text", text: `Unknown action: ${action}` }],
            details: {
              action: "list",
              tasks: [...tasks],
              nextId,
              error: `unknown action: ${action}`,
            } as TaskDetails,
          };
        }
      }
    },

    renderCall(args, theme) {
      let text =
        theme.fg("toolTitle", theme.bold("task_list ")) +
        theme.fg("muted", args.action);
      if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
      if (args.id !== undefined)
        text += ` ${theme.fg("accent", `#${args.id}`)}`;
      if (args.status) text += ` ${theme.fg("muted", `(${args.status})`)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as TaskDetails | undefined;
      if (!details) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "", 0, 0);
      }

      if (details.error) {
        return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
      }

      const taskList = details.tasks;

      switch (details.action) {
        case "list": {
          if (taskList.length === 0) {
            return new Text(theme.fg("dim", "No tasks"), 0, 0);
          }
          let listText = theme.fg("muted", `${taskList.length} task(s):`);
          const display = expanded ? taskList : taskList.slice(0, 5);
          for (const t of display) {
            const icon =
              t.status === "completed"
                ? theme.fg("success", "✓")
                : t.status === "in_progress"
                  ? theme.fg("warning", "●")
                  : theme.fg("dim", "○");
            const statusLabel =
              t.status === "completed"
                ? theme.fg("success", "completed")
                : t.status === "in_progress"
                  ? theme.fg("warning", "in progress")
                  : theme.fg("muted", "pending");
            const itemText =
              t.status === "completed"
                ? theme.fg("dim", t.text)
                : theme.fg("muted", t.text);
            listText += `\n${icon} ${theme.fg("accent", `#${t.id}`)} ${itemText} ${statusLabel}`;
          }
          if (!expanded && taskList.length > 5) {
            listText += `\n${theme.fg("dim", `... ${taskList.length - 5} more`)}`;
          }
          return new Text(listText, 0, 0);
        }

        case "add": {
          const added = taskList[taskList.length - 1];
          return new Text(
            theme.fg("success", "✓ Added ") +
              theme.fg("accent", `#${added.id}`) +
              " " +
              theme.fg("muted", added.text) +
              theme.fg("dim", ` (${STATUS_LABELS[added.status]})`),
            0,
            0
          );
        }

        case "update": {
          const text = result.content[0];
          const msg = text?.type === "text" ? text.text : "";
          return new Text(
            theme.fg("success", "✓ ") + theme.fg("muted", msg),
            0,
            0
          );
        }

        case "remove": {
          const text = result.content[0];
          const msg = text?.type === "text" ? text.text : "";
          return new Text(
            theme.fg("success", "✓ ") + theme.fg("muted", msg),
            0,
            0
          );
        }

        case "clear":
          return new Text(
            theme.fg("success", "✓ ") + theme.fg("muted", "Cleared all tasks"),
            0,
            0
          );
      }
    },
  });

  // Register the /tasks command for users
  pi.registerCommand("tasks", {
    description: "Show all tasks on the current branch",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/tasks requires interactive mode", "error");
        return;
      }

      await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
        return new TaskListComponent(tasks, theme, () => done());
      });
    },
  });
}
