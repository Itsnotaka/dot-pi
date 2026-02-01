import { beforeEach, describe, expect, it } from "vitest";
import {
  createMockExtensionAPI,
  executeTool,
  getTextOutput,
  type MockExtensionAPI,
} from "../helpers.ts";
import initTasks from "../../extensions/tasks.ts";

describe("tasks extension", () => {
  let api: MockExtensionAPI;

  beforeEach(() => {
    api = createMockExtensionAPI();
    initTasks(api);
  });

  describe("add action", () => {
    it("adds a task with default pending status", async () => {
      const result = await executeTool(api, "task_list", {
        action: "add",
        text: "Write tests",
      });
      expect(getTextOutput(result)).toContain("Added task #1");
      expect(getTextOutput(result)).toContain("Write tests");
      expect(getTextOutput(result)).toContain("pending");
    });

    it("adds a task with custom status", async () => {
      const result = await executeTool(api, "task_list", {
        action: "add",
        text: "In progress task",
        status: "in_progress",
      });
      expect(getTextOutput(result)).toContain("in progress");
    });

    it("auto-increments task IDs", async () => {
      await executeTool(api, "task_list", { action: "add", text: "First" });
      const result = await executeTool(api, "task_list", {
        action: "add",
        text: "Second",
      });
      expect(getTextOutput(result)).toContain("#2");
    });

    it("returns error when text is missing", async () => {
      const result = await executeTool(api, "task_list", { action: "add" });
      expect(getTextOutput(result)).toContain("Error");
      expect(getTextOutput(result)).toContain("text required");
    });
  });

  describe("list action", () => {
    it("returns 'No tasks' when empty", async () => {
      const result = await executeTool(api, "task_list", { action: "list" });
      expect(getTextOutput(result)).toBe("No tasks");
    });

    it("lists all tasks", async () => {
      await executeTool(api, "task_list", { action: "add", text: "Task A" });
      await executeTool(api, "task_list", { action: "add", text: "Task B" });
      const result = await executeTool(api, "task_list", { action: "list" });
      const output = getTextOutput(result);
      expect(output).toContain("Task A");
      expect(output).toContain("Task B");
      expect(output).toContain("#1");
      expect(output).toContain("#2");
    });
  });

  describe("update action", () => {
    it("updates task status", async () => {
      await executeTool(api, "task_list", { action: "add", text: "Do thing" });
      const result = await executeTool(api, "task_list", {
        action: "update",
        id: 1,
        status: "completed",
      });
      expect(getTextOutput(result)).toContain("Updated");
      expect(getTextOutput(result)).toContain("completed");
    });

    it("updates task text", async () => {
      await executeTool(api, "task_list", { action: "add", text: "Old text" });
      const result = await executeTool(api, "task_list", {
        action: "update",
        id: 1,
        text: "New text",
      });
      expect(getTextOutput(result)).toContain("New text");
    });

    it("updates both text and status", async () => {
      await executeTool(api, "task_list", { action: "add", text: "Original" });
      const result = await executeTool(api, "task_list", {
        action: "update",
        id: 1,
        text: "Updated",
        status: "in_progress",
      });
      expect(getTextOutput(result)).toContain("Updated");
      expect(getTextOutput(result)).toContain("in progress");
    });

    it("returns error for missing id", async () => {
      const result = await executeTool(api, "task_list", {
        action: "update",
        text: "New text",
      });
      expect(getTextOutput(result)).toContain("Error");
    });

    it("returns error for nonexistent task", async () => {
      const result = await executeTool(api, "task_list", {
        action: "update",
        id: 999,
        text: "New text",
      });
      expect(getTextOutput(result)).toContain("not found");
    });

    it("returns error when no text or status provided", async () => {
      await executeTool(api, "task_list", { action: "add", text: "Task" });
      const result = await executeTool(api, "task_list", {
        action: "update",
        id: 1,
      });
      expect(getTextOutput(result)).toContain("Error");
    });
  });

  describe("remove action", () => {
    it("removes a task by id", async () => {
      await executeTool(api, "task_list", { action: "add", text: "Remove me" });
      const result = await executeTool(api, "task_list", {
        action: "remove",
        id: 1,
      });
      expect(getTextOutput(result)).toContain("Removed");
      expect(getTextOutput(result)).toContain("Remove me");

      const list = await executeTool(api, "task_list", { action: "list" });
      expect(getTextOutput(list)).toBe("No tasks");
    });

    it("returns error for missing id", async () => {
      const result = await executeTool(api, "task_list", { action: "remove" });
      expect(getTextOutput(result)).toContain("Error");
    });

    it("returns error for nonexistent task", async () => {
      const result = await executeTool(api, "task_list", {
        action: "remove",
        id: 42,
      });
      expect(getTextOutput(result)).toContain("not found");
    });
  });

  describe("clear action", () => {
    it("clears all tasks", async () => {
      await executeTool(api, "task_list", { action: "add", text: "One" });
      await executeTool(api, "task_list", { action: "add", text: "Two" });
      const result = await executeTool(api, "task_list", { action: "clear" });
      expect(getTextOutput(result)).toContain("Cleared 2 tasks");
    });

    it("resets ID counter after clear", async () => {
      await executeTool(api, "task_list", { action: "add", text: "One" });
      await executeTool(api, "task_list", { action: "clear" });
      const result = await executeTool(api, "task_list", {
        action: "add",
        text: "After clear",
      });
      expect(getTextOutput(result)).toContain("#1");
    });

    it("clearing empty list shows 0", async () => {
      const result = await executeTool(api, "task_list", { action: "clear" });
      expect(getTextOutput(result)).toContain("Cleared 0 tasks");
    });
  });

  describe("details tracking", () => {
    it("includes full task list in details after add", async () => {
      await executeTool(api, "task_list", { action: "add", text: "First" });
      const result = await executeTool(api, "task_list", {
        action: "add",
        text: "Second",
      });
      const details = result.details as any;
      expect(details.tasks).toHaveLength(2);
      expect(details.tasks[0].text).toBe("First");
      expect(details.tasks[1].text).toBe("Second");
      expect(details.nextId).toBe(3);
    });

    it("tracks action type in details", async () => {
      const result = await executeTool(api, "task_list", { action: "list" });
      expect((result.details as any).action).toBe("list");
    });
  });
});
