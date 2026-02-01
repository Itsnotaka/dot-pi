import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverAgents, formatAgentList, type AgentConfig } from "../../../extensions/subagents/agents.ts";

describe("agent discovery", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `pi-agents-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeAgent(dir: string, filename: string, content: string) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, filename), content);
  }

  const validAgent = `---
name: reviewer
description: Code review agent
model: anthropic/claude-sonnet-4-5
thinking: medium
tools: read,grep,find,bash
---

You are a code reviewer. Review code for quality and security.
`;

  const minimalAgent = `---
name: helper
description: General helper
---

You help with tasks.
`;

  const invalidAgent = `---
description: Missing name field
---

No name in frontmatter.
`;

  describe("discoverAgents", () => {
    it("returns empty when no agents directory exists", () => {
      const result = discoverAgents(tempDir, "project");
      expect(result.agents).toHaveLength(0);
    });

    it("discovers project agents from .pi/agents", () => {
      const agentsDir = join(tempDir, ".pi", "agents");
      writeAgent(agentsDir, "reviewer.md", validAgent);
      const result = discoverAgents(tempDir, "project");
      expect(result.agents).toHaveLength(1);
      expect(result.agents[0].name).toBe("reviewer");
      expect(result.agents[0].source).toBe("project");
    });

    it("parses all fields from frontmatter", () => {
      const agentsDir = join(tempDir, ".pi", "agents");
      writeAgent(agentsDir, "reviewer.md", validAgent);
      const result = discoverAgents(tempDir, "project");
      const agent = result.agents[0];
      expect(agent.name).toBe("reviewer");
      expect(agent.description).toBe("Code review agent");
      expect(agent.model).toBe("anthropic/claude-sonnet-4-5");
      expect(agent.thinking).toBe("medium");
      expect(agent.tools).toEqual(["read", "grep", "find", "bash"]);
      expect(agent.systemPrompt).toContain("code reviewer");
    });

    it("handles minimal agent (name + description only)", () => {
      const agentsDir = join(tempDir, ".pi", "agents");
      writeAgent(agentsDir, "helper.md", minimalAgent);
      const result = discoverAgents(tempDir, "project");
      expect(result.agents).toHaveLength(1);
      expect(result.agents[0].tools).toBeUndefined();
      expect(result.agents[0].model).toBeUndefined();
    });

    it("skips agents missing required fields", () => {
      const agentsDir = join(tempDir, ".pi", "agents");
      writeAgent(agentsDir, "invalid.md", invalidAgent);
      const result = discoverAgents(tempDir, "project");
      expect(result.agents).toHaveLength(0);
    });

    it("skips non-md files", () => {
      const agentsDir = join(tempDir, ".pi", "agents");
      writeAgent(agentsDir, "reviewer.md", validAgent);
      writeFileSync(join(agentsDir, "notes.txt"), "not an agent");
      writeFileSync(join(agentsDir, "config.json"), "{}");
      const result = discoverAgents(tempDir, "project");
      expect(result.agents).toHaveLength(1);
    });

    it("discovers multiple agents", () => {
      const agentsDir = join(tempDir, ".pi", "agents");
      writeAgent(agentsDir, "reviewer.md", validAgent);
      writeAgent(agentsDir, "helper.md", minimalAgent);
      const result = discoverAgents(tempDir, "project");
      expect(result.agents).toHaveLength(2);
      const names = result.agents.map((a) => a.name).sort();
      expect(names).toEqual(["helper", "reviewer"]);
    });

    it("returns projectAgentsDir when found", () => {
      const agentsDir = join(tempDir, ".pi", "agents");
      mkdirSync(agentsDir, { recursive: true });
      const result = discoverAgents(tempDir, "project");
      expect(result.projectAgentsDir).toBe(agentsDir);
    });

    it("returns null projectAgentsDir when not found", () => {
      const result = discoverAgents(tempDir, "project");
      expect(result.projectAgentsDir).toBeNull();
    });

    it("walks up directories to find .pi/agents", () => {
      const deepDir = join(tempDir, "a", "b", "c");
      mkdirSync(deepDir, { recursive: true });
      const agentsDir = join(tempDir, ".pi", "agents");
      writeAgent(agentsDir, "reviewer.md", validAgent);
      const result = discoverAgents(deepDir, "project");
      expect(result.agents).toHaveLength(1);
      expect(result.projectAgentsDir).toBe(agentsDir);
    });
  });

  describe("scope filtering", () => {
    it("user scope only returns user agents", () => {
      const agentsDir = join(tempDir, ".pi", "agents");
      writeAgent(agentsDir, "reviewer.md", validAgent);
      const result = discoverAgents(tempDir, "user");
      const projectAgents = result.agents.filter((a) => a.source === "project");
      expect(projectAgents).toHaveLength(0);
    });

    it("project scope only returns project agents", () => {
      const agentsDir = join(tempDir, ".pi", "agents");
      writeAgent(agentsDir, "reviewer.md", validAgent);
      const result = discoverAgents(tempDir, "project");
      expect(result.agents.every((a) => a.source === "project")).toBe(true);
    });

    it("both scope merges user and project agents", () => {
      const agentsDir = join(tempDir, ".pi", "agents");
      writeAgent(agentsDir, "project-agent.md", minimalAgent);
      const result = discoverAgents(tempDir, "both");
      const projectAgents = result.agents.filter((a) => a.source === "project");
      expect(projectAgents.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe("formatAgentList", () => {
    it("returns 'none' for empty list", () => {
      const { text, remaining } = formatAgentList([], 5);
      expect(text).toBe("none");
      expect(remaining).toBe(0);
    });

    it("formats agents within limit", () => {
      const agents: AgentConfig[] = [
        { name: "a", description: "Agent A", systemPrompt: "", source: "user", filePath: "" },
        { name: "b", description: "Agent B", systemPrompt: "", source: "project", filePath: "" },
      ];
      const { text, remaining } = formatAgentList(agents, 5);
      expect(text).toContain("a (user)");
      expect(text).toContain("b (project)");
      expect(remaining).toBe(0);
    });

    it("truncates when exceeding limit", () => {
      const agents: AgentConfig[] = Array.from({ length: 5 }, (_, i) => ({
        name: `agent-${i}`,
        description: `Desc ${i}`,
        systemPrompt: "",
        source: "user" as const,
        filePath: "",
      }));
      const { text, remaining } = formatAgentList(agents, 2);
      expect(remaining).toBe(3);
      expect(text).toContain("agent-0");
      expect(text).toContain("agent-1");
      expect(text).not.toContain("agent-2");
    });
  });
});
