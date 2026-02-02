import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";

type Quote = "'" | '"' | "`";

const DANGEROUSLY_ALLOW_FLAG = "dangerouslyAllowCommands";
const DANGEROUSLY_ALLOW_PHRASE = "DANGEROUSLY_ALLOW";
const ALLOW_ENTRY_TYPE = "sandbox.allow";

const PIPE_FETCHERS = new Set(["curl", "wget"]);
const PIPE_INTERPRETERS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "fish",
  "pwsh",
  "powershell",
  "python",
  "python3",
  "node",
  "ruby",
  "perl",
]);

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function normalizeCommandName(command: string): string {
  return (command.split("/").pop() ?? command).toLowerCase();
}

function splitTopLevel(input: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: Quote | null = null;
  let escape = false;

  const push = () => {
    const trimmed = current.trim();
    if (trimmed) parts.push(trimmed);
    current = "";
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (escape) {
      current += ch;
      escape = false;
      continue;
    }

    if (ch === "\\" && quote !== "'") {
      escape = true;
      current += ch;
      continue;
    }

    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch as Quote;
      current += ch;
      continue;
    }

    if (ch === "&" && input[i + 1] === "&") {
      push();
      i++;
      continue;
    }

    if (ch === "|" && input[i + 1] === "|") {
      push();
      i++;
      continue;
    }

    if (ch === ";" || ch === "\n") {
      push();
      continue;
    }

    current += ch;
  }

  push();
  return parts;
}

function splitPipeline(input: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: Quote | null = null;
  let escape = false;

  const push = () => {
    const trimmed = current.trim();
    if (trimmed) parts.push(trimmed);
    current = "";
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (escape) {
      current += ch;
      escape = false;
      continue;
    }

    if (ch === "\\" && quote !== "'") {
      escape = true;
      current += ch;
      continue;
    }

    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch as Quote;
      current += ch;
      continue;
    }

    if (ch === "|" && input[i + 1] !== "|") {
      push();
      continue;
    }

    current += ch;
  }

  push();
  return parts;
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: Quote | null = null;
  let escape = false;

  const push = () => {
    if (current.length > 0) tokens.push(current);
    current = "";
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (escape) {
      current += ch;
      escape = false;
      continue;
    }

    if (ch === "\\" && quote !== "'") {
      escape = true;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      current += ch;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch as Quote;
      continue;
    }

    if (/\s/.test(ch)) {
      push();
      continue;
    }

    current += ch;
  }

  push();
  return tokens;
}

function isEnvAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function parseCommandInfo(raw: string) {
  const tokens = tokenize(raw);
  let idx = 0;
  let sudo = false;

  while (idx < tokens.length && isEnvAssignment(tokens[idx])) idx++;

  while (idx < tokens.length) {
    const token = tokens[idx];

    if (token === "sudo") {
      sudo = true;
      idx++;
      while (idx < tokens.length && tokens[idx].startsWith("-")) {
        if (tokens[idx] === "--") {
          idx++;
          break;
        }
        idx++;
      }
      continue;
    }

    if (token === "env") {
      idx++;
      while (idx < tokens.length) {
        const envToken = tokens[idx];
        if (envToken === "--") {
          idx++;
          break;
        }
        if (envToken.startsWith("-") || isEnvAssignment(envToken)) {
          idx++;
          continue;
        }
        break;
      }
      continue;
    }

    if (token === "command" || token === "time") {
      idx++;
      continue;
    }

    break;
  }

  const command = tokens[idx] ?? null;
  const args = command ? tokens.slice(idx + 1) : [];
  return {
    raw,
    tokens,
    command,
    commandName: command ? normalizeCommandName(command) : null,
    args,
    sudo,
  };
}

function parseSegment(raw: string) {
  const pipeline = splitPipeline(raw).map((part) => parseCommandInfo(part));
  return { raw, pipeline };
}

function hasShortFlag(args: string[], flag: string): boolean {
  return args.some(
    (arg) => arg.startsWith("-") && !arg.startsWith("--") && arg.includes(flag)
  );
}

function hasLongFlag(args: string[], flag: string): boolean {
  const target = `--${flag}`;
  return args.some((arg) => arg === target || arg.startsWith(`${target}=`));
}

function getFirstNonFlagArg(args: string[]): string | null {
  for (const arg of args) {
    if (arg === "--") continue;
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return null;
}

function getNthNonFlagArg(args: string[], index: number): string | null {
  let seen = 0;
  for (const arg of args) {
    if (arg === "--") continue;
    if (arg.startsWith("-")) continue;
    if (seen === index) return arg;
    seen++;
  }
  return null;
}

function getGitSubcommand(args: string[]): {
  subcommand: string | null;
  rest: string[];
} {
  const flagsWithValues = new Set([
    "-C",
    "-c",
    "--git-dir",
    "--work-tree",
    "--namespace",
  ]);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return { subcommand: null, rest: [] };
    if (arg.startsWith("-")) {
      if (flagsWithValues.has(arg)) i++;
      continue;
    }
    return { subcommand: arg, rest: args.slice(i + 1) };
  }

  return { subcommand: null, rest: [] };
}

interface CommandInfo {
  raw: string;
  tokens: string[];
  command: string | null;
  commandName: string | null;
  args: string[];
  sudo: boolean;
}

interface Segment {
  raw: string;
  pipeline: CommandInfo[];
}

interface GuardRule {
  label: string;
  typed: boolean;
  match: (command: CommandInfo, segment: Segment) => boolean;
}

const guardRules: GuardRule[] = [
  {
    label: "Git push",
    typed: false,
    match: (command) => {
      if (command.commandName !== "git") return false;
      const { subcommand, rest } = getGitSubcommand(command.args);
      if (subcommand !== "push") return false;
      const isForce =
        hasLongFlag(rest, "force") ||
        hasLongFlag(rest, "force-with-lease") ||
        hasShortFlag(rest, "f");
      return !isForce;
    },
  },
  {
    label: "Git force push",
    typed: true,
    match: (command) => {
      if (command.commandName !== "git") return false;
      const { subcommand, rest } = getGitSubcommand(command.args);
      if (subcommand !== "push") return false;
      return (
        hasLongFlag(rest, "force") ||
        hasLongFlag(rest, "force-with-lease") ||
        hasShortFlag(rest, "f")
      );
    },
  },
  {
    label: "Git hard reset",
    typed: false,
    match: (command) => {
      if (command.commandName !== "git") return false;
      const { subcommand, rest } = getGitSubcommand(command.args);
      return subcommand === "reset" && hasLongFlag(rest, "hard");
    },
  },
  {
    label: "Git clean",
    typed: false,
    match: (command) => {
      if (command.commandName !== "git") return false;
      const { subcommand, rest } = getGitSubcommand(command.args);
      return (
        subcommand === "clean" &&
        (hasShortFlag(rest, "f") || hasLongFlag(rest, "force"))
      );
    },
  },
  {
    label: "Package publish",
    typed: true,
    match: (command) => {
      if (!command.commandName) return false;
      if (!["npm", "pnpm", "yarn", "bun"].includes(command.commandName))
        return false;
      const sub = getFirstNonFlagArg(command.args);
      if (sub === "run" || sub === "exec") return false;
      return command.args.includes("publish") || sub === "publish";
    },
  },
  {
    label: "npm unpublish/deprecate",
    typed: true,
    match: (command) => {
      if (command.commandName !== "npm") return false;
      const sub = getFirstNonFlagArg(command.args);
      return sub === "unpublish" || sub === "deprecate";
    },
  },
  {
    label: "PyPI publish",
    typed: true,
    match: (command) =>
      command.commandName === "twine" && command.args.includes("upload"),
  },
  {
    label: "Cargo publish",
    typed: true,
    match: (command) =>
      command.commandName === "cargo" &&
      (command.args.includes("publish") || command.args.includes("yank")),
  },
  {
    label: "Gem publish",
    typed: true,
    match: (command) =>
      command.commandName === "gem" && command.args.includes("push"),
  },
  {
    label: "Deploy",
    typed: false,
    match: (command) => {
      if (!command.commandName) return false;
      if (command.commandName === "vercel") {
        const sub = getFirstNonFlagArg(command.args);
        return !sub || sub === "deploy" || command.args.includes("--prod");
      }
      if (
        ["netlify", "firebase", "fly", "flyctl", "railway"].includes(
          command.commandName
        )
      ) {
        return command.args.includes("deploy") || command.args.includes("up");
      }
      return false;
    },
  },
  {
    label: "Terraform mutation",
    typed: true,
    match: (command) => {
      if (command.commandName !== "terraform") return false;
      const sub = getFirstNonFlagArg(command.args);
      return sub === "apply" || sub === "destroy" || sub === "import";
    },
  },
  {
    label: "Pulumi mutation",
    typed: true,
    match: (command) => {
      if (command.commandName !== "pulumi") return false;
      const sub = getFirstNonFlagArg(command.args);
      return sub === "up" || sub === "destroy";
    },
  },
  {
    label: "Kubectl mutation",
    typed: false,
    match: (command) => {
      if (command.commandName !== "kubectl") return false;
      const sub = getFirstNonFlagArg(command.args);
      return (
        sub === "apply" ||
        sub === "delete" ||
        sub === "patch" ||
        sub === "replace" ||
        sub === "scale"
      );
    },
  },
  {
    label: "Helm mutation",
    typed: false,
    match: (command) => {
      if (command.commandName !== "helm") return false;
      const sub = getFirstNonFlagArg(command.args);
      return (
        sub === "install" ||
        sub === "upgrade" ||
        sub === "uninstall" ||
        sub === "delete"
      );
    },
  },
  {
    label: "Docker push",
    typed: true,
    match: (command) =>
      command.commandName === "docker" && command.args.includes("push"),
  },
  {
    label: "Docker compose (foreground)",
    typed: false,
    match: (command) => {
      if (command.commandName === "docker") {
        const sub = getNthNonFlagArg(command.args, 0);
        const sub2 = getNthNonFlagArg(command.args, 1);
        const detached =
          command.args.includes("-d") || command.args.includes("--detach");
        return sub === "compose" && sub2 === "up" && !detached;
      }
      if (command.commandName === "docker-compose") {
        const sub = getNthNonFlagArg(command.args, 0);
        const detached =
          command.args.includes("-d") || command.args.includes("--detach");
        return sub === "up" && !detached;
      }
      return false;
    },
  },
  {
    label: "AWS destructive",
    typed: false,
    match: (command) =>
      command.commandName === "aws" &&
      command.args.some((arg) =>
        /\b(delete|terminate|destroy|rm|purge)\b/.test(arg)
      ),
  },
  {
    label: "Pipe to interpreter",
    typed: true,
    match: (_command, segment) => {
      let sawFetcher = false;
      for (const part of segment.pipeline) {
        const cmd = part.commandName;
        if (!cmd) continue;
        if (PIPE_FETCHERS.has(cmd)) sawFetcher = true;
        if (sawFetcher && PIPE_INTERPRETERS.has(cmd)) return true;
      }
      return false;
    },
  },
  {
    label: "GitHub CLI mutation",
    typed: false,
    match: (command) => {
      if (command.commandName !== "gh") return false;
      const sub = getFirstNonFlagArg(command.args);
      if (sub === "pr")
        return command.args.includes("merge") || command.args.includes("close");
      if (sub === "repo")
        return (
          command.args.includes("create") || command.args.includes("delete")
        );
      if (sub === "release")
        return (
          command.args.includes("create") || command.args.includes("delete")
        );
      if (sub === "api")
        return command.args.some(
          (a) =>
            /^-X\s*(POST|PUT|PATCH|DELETE)$/i.test(a) || /^--method$/i.test(a)
        );
      return false;
    },
  },
];

function evaluateCommand(command: string) {
  const matches: { label: string; typed: boolean }[] = [];
  const segments = splitTopLevel(command).map((segment) =>
    parseSegment(segment)
  );

  for (const segment of segments) {
    for (const part of segment.pipeline) {
      for (const rule of guardRules) {
        if (rule.match(part, segment))
          matches.push({ label: rule.label, typed: rule.typed });
      }
    }
  }

  return matches;
}

export default function (pi: ExtensionAPI) {
  pi.registerFlag(DANGEROUSLY_ALLOW_FLAG, {
    description: "Bypass command guard prompts",
    type: "boolean",
    default: false,
  });

  const allowedCommands = new Set<string>();

  const loadAllowlist = (ctx: ExtensionContext) => {
    allowedCommands.clear();
    const entries = ctx.sessionManager.getEntries();
    for (const entry of entries) {
      if (entry.type !== "custom" || entry.customType !== ALLOW_ENTRY_TYPE)
        continue;
      const data = entry.data as { command?: unknown } | undefined;
      if (typeof data?.command === "string")
        allowedCommands.add(normalizeCommand(data.command));
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    loadAllowlist(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    loadAllowlist(ctx);
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;
    if (pi.getFlag(DANGEROUSLY_ALLOW_FLAG) === true) return;

    const cmd = event.input.command;
    if (!cmd) return;

    const normalized = normalizeCommand(cmd);
    if (allowedCommands.has(normalized)) return;

    const matches = evaluateCommand(cmd);
    if (matches.length === 0) return;

    const labels = Array.from(new Set(matches.map((m) => m.label)));
    const tag = labels.join(", ");
    const needsTypedConfirm = matches.some((m) => m.typed);

    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `Blocked (no UI): ${tag}. Use --${DANGEROUSLY_ALLOW_FLAG} to bypass.`,
      };
    }

    if (needsTypedConfirm) {
      const response = await ctx.ui.input(
        `⚠️ ${tag}\n${cmd}`,
        `Type ${DANGEROUSLY_ALLOW_PHRASE} to allow`
      );
      if (response !== DANGEROUSLY_ALLOW_PHRASE) {
        return { block: true, reason: `User rejected command (${tag})` };
      }
      allowedCommands.add(normalized);
      pi.appendEntry(ALLOW_ENTRY_TYPE, { command: normalized });
      return;
    }

    const allowed = await ctx.ui.confirm(`⚠️ ${tag}`, cmd);
    if (!allowed) {
      return { block: true, reason: `User rejected command (${tag})` };
    }

    allowedCommands.add(normalized);
    pi.appendEntry(ALLOW_ENTRY_TYPE, { command: normalized });
  });
}
