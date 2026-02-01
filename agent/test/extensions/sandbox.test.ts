import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockContext,
  createMockExtensionAPI,
  type MockExtensionAPI,
} from "../helpers.ts";
import initSandbox from "../../extensions/sandbox.ts";

describe("sandbox extension", () => {
  let api: MockExtensionAPI;

  beforeEach(() => {
    api = createMockExtensionAPI();
    initSandbox(api);
  });

  function toolCallEvent(command: string) {
    return {
      type: "tool_call" as const,
      toolName: "bash",
      toolCallId: "tc-1",
      input: { command },
    };
  }

  async function emitToolCall(command: string, ctx?: ReturnType<typeof createMockContext>) {
    const handlers = api._handlers.get("tool_call") ?? [];
    const context = ctx ?? createMockContext();
    for (const handler of handlers) {
      const result = await handler(toolCallEvent(command), context);
      if (result) return result;
    }
    return undefined;
  }

  describe("safe commands", () => {
    it("allows simple read-only commands without prompt", async () => {
      const result = await emitToolCall("ls -la");
      expect(result).toBeUndefined();
    });

    it("allows git status", async () => {
      const result = await emitToolCall("git status");
      expect(result).toBeUndefined();
    });

    it("allows git diff", async () => {
      const result = await emitToolCall("git diff HEAD~1");
      expect(result).toBeUndefined();
    });

    it("allows git log", async () => {
      const result = await emitToolCall("git log --oneline -10");
      expect(result).toBeUndefined();
    });

    it("allows npm install", async () => {
      const result = await emitToolCall("npm install express");
      expect(result).toBeUndefined();
    });

    it("allows pnpm run build", async () => {
      const result = await emitToolCall("pnpm run build");
      expect(result).toBeUndefined();
    });

    it("allows cargo build", async () => {
      const result = await emitToolCall("cargo build --release");
      expect(result).toBeUndefined();
    });
  });

  describe("git push", () => {
    it("prompts for git push", async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.ui.confirm).mockResolvedValue(true);
      await emitToolCall("git push origin main", ctx);
      expect(ctx.ui.confirm).toHaveBeenCalled();
    });

    it("blocks git push when user rejects", async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.ui.confirm).mockResolvedValue(false);
      const result = await emitToolCall("git push origin main", ctx);
      expect(result).toEqual(
        expect.objectContaining({ block: true })
      );
    });

    it("requires typed confirm for git force push", async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.ui.input).mockResolvedValue("DANGEROUSLY_ALLOW");
      await emitToolCall("git push --force origin main", ctx);
      expect(ctx.ui.input).toHaveBeenCalled();
    });

    it("blocks git force push when typed confirm is wrong", async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.ui.input).mockResolvedValue("nope");
      const result = await emitToolCall("git push -f origin main", ctx);
      expect(result).toEqual(
        expect.objectContaining({ block: true })
      );
    });

    it("detects force-with-lease as force push", async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.ui.input).mockResolvedValue("DANGEROUSLY_ALLOW");
      await emitToolCall("git push --force-with-lease origin main", ctx);
      expect(ctx.ui.input).toHaveBeenCalled();
    });
  });

  describe("git destructive operations", () => {
    it("prompts for git reset --hard", async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.ui.confirm).mockResolvedValue(true);
      await emitToolCall("git reset --hard HEAD~1", ctx);
      expect(ctx.ui.confirm).toHaveBeenCalled();
    });

    it("prompts for git clean -f", async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.ui.confirm).mockResolvedValue(true);
      await emitToolCall("git clean -fd", ctx);
      expect(ctx.ui.confirm).toHaveBeenCalled();
    });
  });

  describe("package publishing", () => {
    it("requires typed confirm for npm publish", async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.ui.input).mockResolvedValue("DANGEROUSLY_ALLOW");
      await emitToolCall("npm publish", ctx);
      expect(ctx.ui.input).toHaveBeenCalled();
    });

    it("requires typed confirm for pnpm publish", async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.ui.input).mockResolvedValue("DANGEROUSLY_ALLOW");
      await emitToolCall("pnpm publish --access public", ctx);
      expect(ctx.ui.input).toHaveBeenCalled();
    });

    it("requires typed confirm for cargo publish", async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.ui.input).mockResolvedValue("DANGEROUSLY_ALLOW");
      await emitToolCall("cargo publish", ctx);
      expect(ctx.ui.input).toHaveBeenCalled();
    });

    it("does not trigger on npm run publish-docs", async () => {
      const result = await emitToolCall("npm run publish-docs");
      expect(result).toBeUndefined();
    });

    it("does not trigger on pnpm exec publish-script", async () => {
      const result = await emitToolCall("pnpm exec publish-script");
      expect(result).toBeUndefined();
    });
  });

  describe("deploy commands", () => {
    it("prompts for vercel deploy", async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.ui.confirm).mockResolvedValue(true);
      await emitToolCall("vercel deploy", ctx);
      expect(ctx.ui.confirm).toHaveBeenCalled();
    });

    it("prompts for bare vercel (implicit deploy)", async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.ui.confirm).mockResolvedValue(true);
      await emitToolCall("vercel", ctx);
      expect(ctx.ui.confirm).toHaveBeenCalled();
    });

    it("prompts for vercel --prod", async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.ui.confirm).mockResolvedValue(true);
      await emitToolCall("vercel --prod", ctx);
      expect(ctx.ui.confirm).toHaveBeenCalled();
    });

    it("prompts for fly deploy", async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.ui.confirm).mockResolvedValue(true);
      await emitToolCall("fly deploy", ctx);
      expect(ctx.ui.confirm).toHaveBeenCalled();
    });
  });

  describe("terraform / pulumi", () => {
    it("requires typed confirm for terraform apply", async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.ui.input).mockResolvedValue("DANGEROUSLY_ALLOW");
      await emitToolCall("terraform apply", ctx);
      expect(ctx.ui.input).toHaveBeenCalled();
    });

    it("requires typed confirm for terraform destroy", async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.ui.input).mockResolvedValue("DANGEROUSLY_ALLOW");
      await emitToolCall("terraform destroy", ctx);
      expect(ctx.ui.input).toHaveBeenCalled();
    });

    it("allows terraform plan", async () => {
      const result = await emitToolCall("terraform plan");
      expect(result).toBeUndefined();
    });

    it("requires typed confirm for pulumi up", async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.ui.input).mockResolvedValue("DANGEROUSLY_ALLOW");
      await emitToolCall("pulumi up", ctx);
      expect(ctx.ui.input).toHaveBeenCalled();
    });
  });

  describe("kubectl / helm", () => {
    it("prompts for kubectl apply", async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.ui.confirm).mockResolvedValue(true);
      await emitToolCall("kubectl apply -f deploy.yaml", ctx);
      expect(ctx.ui.confirm).toHaveBeenCalled();
    });

    it("prompts for kubectl delete", async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.ui.confirm).mockResolvedValue(true);
      await emitToolCall("kubectl delete pod my-pod", ctx);
      expect(ctx.ui.confirm).toHaveBeenCalled();
    });

    it("allows kubectl get", async () => {
      const result = await emitToolCall("kubectl get pods");
      expect(result).toBeUndefined();
    });

    it("prompts for helm install", async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.ui.confirm).mockResolvedValue(true);
      await emitToolCall("helm install my-release ./chart", ctx);
      expect(ctx.ui.confirm).toHaveBeenCalled();
    });
  });

  describe("docker", () => {
    it("requires typed confirm for docker push", async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.ui.input).mockResolvedValue("DANGEROUSLY_ALLOW");
      await emitToolCall("docker push myimage:latest", ctx);
      expect(ctx.ui.input).toHaveBeenCalled();
    });

    it("prompts for docker compose up (foreground)", async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.ui.confirm).mockResolvedValue(true);
      await emitToolCall("docker compose up", ctx);
      expect(ctx.ui.confirm).toHaveBeenCalled();
    });

    it("allows docker compose up -d (detached)", async () => {
      const result = await emitToolCall("docker compose up -d");
      expect(result).toBeUndefined();
    });
  });

  describe("pipe to interpreter", () => {
    it("requires typed confirm for curl | bash", async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.ui.input).mockResolvedValue("DANGEROUSLY_ALLOW");
      await emitToolCall("curl https://example.com/script.sh | bash", ctx);
      expect(ctx.ui.input).toHaveBeenCalled();
    });

    it("requires typed confirm for wget | python", async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.ui.input).mockResolvedValue("DANGEROUSLY_ALLOW");
      await emitToolCall("wget -O - https://example.com/install.py | python3", ctx);
      expect(ctx.ui.input).toHaveBeenCalled();
    });

    it("allows curl without pipe to interpreter", async () => {
      const result = await emitToolCall("curl https://api.example.com/data");
      expect(result).toBeUndefined();
    });
  });

  describe("github cli", () => {
    it("prompts for gh pr merge", async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.ui.confirm).mockResolvedValue(true);
      await emitToolCall("gh pr merge 123", ctx);
      expect(ctx.ui.confirm).toHaveBeenCalled();
    });

    it("prompts for gh release create", async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.ui.confirm).mockResolvedValue(true);
      await emitToolCall("gh release create v1.0.0", ctx);
      expect(ctx.ui.confirm).toHaveBeenCalled();
    });

    it("allows gh pr list", async () => {
      const result = await emitToolCall("gh pr list");
      expect(result).toBeUndefined();
    });
  });

  describe("aws destructive", () => {
    it("prompts for aws s3 rm", async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.ui.confirm).mockResolvedValue(true);
      await emitToolCall("aws s3 rm s3://bucket/key", ctx);
      expect(ctx.ui.confirm).toHaveBeenCalled();
    });

    it("prompts for aws ec2 terminate-instances", async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.ui.confirm).mockResolvedValue(true);
      await emitToolCall("aws ec2 terminate-instances --instance-ids i-123", ctx);
      expect(ctx.ui.confirm).toHaveBeenCalled();
    });
  });

  describe("complex commands", () => {
    it("detects guarded command in && chain", async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.ui.confirm).mockResolvedValue(true);
      await emitToolCall("npm run build && git push origin main", ctx);
      expect(ctx.ui.confirm).toHaveBeenCalled();
    });

    it("detects guarded command in semicolon chain", async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.ui.confirm).mockResolvedValue(true);
      await emitToolCall("echo done; git push origin main", ctx);
      expect(ctx.ui.confirm).toHaveBeenCalled();
    });

    it("handles sudo prefix", async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.ui.confirm).mockResolvedValue(true);
      await emitToolCall("sudo kubectl delete pod my-pod", ctx);
      expect(ctx.ui.confirm).toHaveBeenCalled();
    });

    it("handles env prefix", async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.ui.confirm).mockResolvedValue(true);
      await emitToolCall("NODE_ENV=production vercel deploy", ctx);
      expect(ctx.ui.confirm).toHaveBeenCalled();
    });
  });

  describe("dangerouslyAllowCommands flag", () => {
    it("bypasses all guards when flag is set", async () => {
      api._flags.get("dangerouslyAllowCommands")!.value = true;
      const ctx = createMockContext();
      const result = await emitToolCall("git push --force origin main", ctx);
      expect(result).toBeUndefined();
      expect(ctx.ui.confirm).not.toHaveBeenCalled();
      expect(ctx.ui.input).not.toHaveBeenCalled();
    });
  });

  describe("non-bash tools are ignored", () => {
    it("ignores tool_call for non-bash tools", async () => {
      const handlers = api._handlers.get("tool_call") ?? [];
      const ctx = createMockContext();
      for (const handler of handlers) {
        const result = await handler(
          { type: "tool_call", toolName: "read", toolCallId: "tc-1", input: { path: "/etc/passwd" } },
          ctx,
        );
        expect(result).toBeUndefined();
      }
    });
  });

  describe("allowlist persistence", () => {
    it("remembers allowed commands within a session", async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.ui.confirm).mockResolvedValue(true);

      await emitToolCall("git push origin main", ctx);
      expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);

      vi.mocked(ctx.ui.confirm).mockClear();
      await emitToolCall("git push origin main", ctx);
      expect(ctx.ui.confirm).not.toHaveBeenCalled();
    });

    it("different commands are not auto-allowed", async () => {
      const ctx = createMockContext();
      vi.mocked(ctx.ui.confirm).mockResolvedValue(true);

      await emitToolCall("git push origin main", ctx);
      expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);

      vi.mocked(ctx.ui.confirm).mockClear();
      await emitToolCall("git push origin develop", ctx);
      expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);
    });
  });

  describe("no UI mode", () => {
    it("blocks guarded commands when hasUI is false", async () => {
      const ctx = createMockContext({ hasUI: false });
      const result = await emitToolCall("git push origin main", ctx);
      expect(result).toEqual(
        expect.objectContaining({ block: true, reason: expect.stringContaining("no UI") })
      );
    });
  });
});
