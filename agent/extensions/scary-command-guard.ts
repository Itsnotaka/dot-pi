import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

type Severity = "ask" | "deny";

type CommandInfo = {
  raw: string;
  tokens: string[];
  command: string | null;
  commandName: string | null;
  args: string[];
  sudo: boolean;
};

type SegmentInfo = {
  raw: string;
  pipeline: CommandInfo[];
};

type RuleMatch = {
  label: string;
  severity: Severity;
};

type SegmentRule = {
  label: string;
  severity: Severity;
  match: (segment: SegmentInfo) => boolean;
};

type CommandRule = {
  label: string;
  severity: Severity;
  match: (command: CommandInfo, segment: SegmentInfo) => boolean;
};

type Quote = "'" | '"' | "`";

const DANGEROUSLY_ALLOW_FLAG = "dangerouslyAllowCommands";
const DANGEROUSLY_ALLOW_PHRASE = "DANGEROUSLY_ALLOW";
const ALLOW_ENTRY_TYPE = "scary-command-guard.allow";

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

const SQL_CLIENTS = new Set(["psql", "mysql", "sqlite3", "sqlcmd", "mariadb"]);

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

function parseCommandInfo(raw: string): CommandInfo {
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

function parseSegment(raw: string): SegmentInfo {
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

function hasRecursiveFlag(flags: string[]): boolean {
  const shortFlags = flags.filter(
    (arg) => arg.startsWith("-") && !arg.startsWith("--")
  );
  const hasShort = shortFlags.some(
    (arg) => arg.includes("r") || arg.includes("R")
  );
  return hasShort || hasLongFlag(flags, "recursive");
}

function splitOnDoubleDash(args: string[]): {
  before: string[];
  after: string[];
} {
  const idx = args.indexOf("--");
  if (idx === -1) return { before: args, after: [] };
  return { before: args.slice(0, idx), after: args.slice(idx + 1) };
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

function isNuclearTarget(target: string): boolean {
  const cleaned = target.replace(/^['"]|['"]$/g, "");
  return (
    cleaned === "/" ||
    cleaned === "/*" ||
    cleaned === "~" ||
    cleaned === "~/" ||
    cleaned === "$HOME" ||
    cleaned === "${HOME}" ||
    cleaned === "$HOME/" ||
    cleaned === "${HOME}/"
  );
}

function matchesSqlDestructive(segment: SegmentInfo): boolean {
  const sqlPattern =
    /\b(drop\s+(table|database|schema)|truncate|delete\s+from)\b/i;
  return sqlPattern.test(segment.raw);
}

const segmentRules: SegmentRule[] = [
  {
    label: "Pipe to interpreter",
    severity: "deny",
    match: (segment) => {
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
];

const commandRules: CommandRule[] = [
  {
    label: "Recursive delete",
    severity: "ask",
    match: (command) => {
      if (command.commandName !== "rm") return false;
      const { before, after } = splitOnDoubleDash(command.args);
      const flags = before.filter((arg) => arg.startsWith("-"));
      const targets = [
        ...before.filter((arg) => !arg.startsWith("-")),
        ...after,
      ];
      const hasRecursive = hasRecursiveFlag(flags);
      const nuclear =
        targets.some((target) => isNuclearTarget(target)) ||
        hasLongFlag(flags, "no-preserve-root");
      return hasRecursive && !nuclear;
    },
  },
  {
    label: "Recursive delete (root/home)",
    severity: "deny",
    match: (command) => {
      if (command.commandName !== "rm") return false;
      const { before, after } = splitOnDoubleDash(command.args);
      const flags = before.filter((arg) => arg.startsWith("-"));
      const targets = [
        ...before.filter((arg) => !arg.startsWith("-")),
        ...after,
      ];
      const hasRecursive = hasRecursiveFlag(flags);
      const nuclear =
        targets.some((target) => isNuclearTarget(target)) ||
        hasLongFlag(flags, "no-preserve-root");
      return hasRecursive && nuclear;
    },
  },
  {
    label: "Format filesystem",
    severity: "deny",
    match: (command) =>
      Boolean(command.commandName && command.commandName.startsWith("mkfs")),
  },
  {
    label: "Disk write (dd)",
    severity: "deny",
    match: (command) =>
      command.commandName === "dd" &&
      command.args.some(
        (arg) =>
          arg.startsWith("of=/dev/") ||
          arg.startsWith("if=/dev/") ||
          arg.includes("/dev/")
      ),
  },
  {
    label: "Disk write (dd)",
    severity: "ask",
    match: (command) => command.commandName === "dd",
  },
  {
    label: "Git push",
    severity: "ask",
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
    severity: "ask",
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
    severity: "ask",
    match: (command) => {
      if (command.commandName !== "git") return false;
      const { subcommand, rest } = getGitSubcommand(command.args);
      return subcommand === "reset" && hasLongFlag(rest, "hard");
    },
  },
  {
    label: "Git clean",
    severity: "ask",
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
    label: "Git discard all changes",
    severity: "ask",
    match: (command) => {
      if (command.commandName !== "git") return false;
      const { subcommand, rest } = getGitSubcommand(command.args);
      if (subcommand !== "checkout" && subcommand !== "restore") return false;
      const markerIndex = rest.indexOf("--");
      if (markerIndex === -1) return false;
      return rest
        .slice(markerIndex + 1)
        .some((arg) => arg === "." || arg === "./");
    },
  },
  {
    label: "Package publish",
    severity: "ask",
    match: (command) => {
      if (!command.commandName) return false;
      if (!["npm", "pnpm", "yarn", "bun"].includes(command.commandName))
        return false;
      const firstSubcommand = getFirstNonFlagArg(command.args);
      if (firstSubcommand === "run" || firstSubcommand === "exec") return false;
      return command.args.includes("publish") || firstSubcommand === "publish";
    },
  },
  {
    label: "PyPI publish",
    severity: "ask",
    match: (command) =>
      command.commandName === "twine" && command.args.includes("upload"),
  },
  {
    label: "RubyGems publish",
    severity: "ask",
    match: (command) =>
      command.commandName === "gem" && command.args.includes("push"),
  },
  {
    label: "Cargo publish",
    severity: "ask",
    match: (command) =>
      command.commandName === "cargo" && command.args.includes("publish"),
  },
  {
    label: "Deno publish",
    severity: "ask",
    match: (command) =>
      command.commandName === "deno" && command.args.includes("publish"),
  },
  {
    label: "JSR publish",
    severity: "ask",
    match: (command) =>
      command.commandName === "jsr" && command.args.includes("publish"),
  },
  {
    label: "Hex publish",
    severity: "ask",
    match: (command) =>
      command.commandName === "mix" && command.args.includes("hex.publish"),
  },
  {
    label: "NuGet publish",
    severity: "ask",
    match: (command) =>
      command.commandName === "dotnet" &&
      getNthNonFlagArg(command.args, 0) === "nuget" &&
      getNthNonFlagArg(command.args, 1) === "push",
  },
  {
    label: "CocoaPods publish",
    severity: "ask",
    match: (command) =>
      command.commandName === "pod" &&
      getNthNonFlagArg(command.args, 0) === "trunk" &&
      getNthNonFlagArg(command.args, 1) === "push",
  },
  {
    label: "Deploy",
    severity: "ask",
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
    severity: "ask",
    match: (command) =>
      command.commandName === "terraform" &&
      (getFirstNonFlagArg(command.args) === "apply" ||
        getFirstNonFlagArg(command.args) === "destroy"),
  },
  {
    label: "Pulumi mutation",
    severity: "ask",
    match: (command) =>
      command.commandName === "pulumi" &&
      (getFirstNonFlagArg(command.args) === "up" ||
        getFirstNonFlagArg(command.args) === "destroy"),
  },
  {
    label: "Kubectl mutation",
    severity: "ask",
    match: (command) => {
      if (command.commandName !== "kubectl") return false;
      const sub = getFirstNonFlagArg(command.args);
      return sub === "apply" || sub === "delete" || sub === "rollout";
    },
  },
  {
    label: "Helm mutation",
    severity: "ask",
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
    label: "AWS destructive",
    severity: "ask",
    match: (command) =>
      command.commandName === "aws" &&
      command.args.some((arg) =>
        /\b(delete|terminate|destroy|rm|purge)\b/.test(arg)
      ),
  },
  {
    label: "Elevated privileges",
    severity: "ask",
    match: (command) => command.sudo,
  },
  {
    label: "Open permissions (777)",
    severity: "ask",
    match: (command) =>
      command.commandName === "chmod" && command.args.includes("777"),
  },
  {
    label: "Recursive chmod",
    severity: "ask",
    match: (command) =>
      command.commandName === "chmod" &&
      (hasShortFlag(command.args, "R") ||
        hasLongFlag(command.args, "recursive")),
  },
  {
    label: "Change ownership",
    severity: "ask",
    match: (command) => command.commandName === "chown",
  },
  {
    label: "SQL destructive",
    severity: "ask",
    match: (command, segment) =>
      command.commandName !== null &&
      SQL_CLIENTS.has(command.commandName) &&
      matchesSqlDestructive(segment),
  },
  {
    label: "Docker compose (foreground)",
    severity: "ask",
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
];

function evaluateCommand(command: string): RuleMatch[] {
  const matches: RuleMatch[] = [];
  const segments = splitTopLevel(command).map((segment) =>
    parseSegment(segment)
  );

  for (const segment of segments) {
    for (const rule of segmentRules) {
      if (rule.match(segment))
        matches.push({ label: rule.label, severity: rule.severity });
    }
    for (const part of segment.pipeline) {
      for (const rule of commandRules) {
        if (rule.match(part, segment))
          matches.push({ label: rule.label, severity: rule.severity });
      }
    }
  }

  return matches;
}

export default function (pi: ExtensionAPI) {
  pi.registerFlag(DANGEROUSLY_ALLOW_FLAG, {
    description: "Bypass scary command guard prompts",
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
    if (event.toolName !== "bash") return;
    if (pi.getFlag(DANGEROUSLY_ALLOW_FLAG) === true) return;

    const cmd = (event.input as Record<string, unknown>).command as string;
    if (!cmd) return;

    const normalized = normalizeCommand(cmd);
    if (allowedCommands.has(normalized)) return;

    const matches = evaluateCommand(cmd);
    if (matches.length === 0) return;

    const labels = Array.from(new Set(matches.map((m) => m.label)));
    const tag = labels.join(", ");
    const severity: Severity = matches.some((m) => m.severity === "deny")
      ? "deny"
      : "ask";

    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `Blocked scary command (no UI): ${tag}. Use --${DANGEROUSLY_ALLOW_FLAG} to bypass.`,
      };
    }

    if (severity === "deny") {
      const response = await ctx.ui.input(
        `⚠️ ${tag}\n${cmd}`,
        `Type ${DANGEROUSLY_ALLOW_PHRASE} to allow`
      );
      if (response !== DANGEROUSLY_ALLOW_PHRASE) {
        return { block: true, reason: `User rejected command (${tag})` };
      }
      return;
    }

    const choice = await ctx.ui.select(`⚠️ ${tag}\n${cmd}`, [
      "Allow once",
      "Always allow (session)",
      "Reject",
    ]);

    if (!choice || choice === "Reject") {
      return { block: true, reason: `User rejected command (${tag})` };
    }

    if (
      choice === "Always allow (session)" &&
      !allowedCommands.has(normalized)
    ) {
      allowedCommands.add(normalized);
      pi.appendEntry(ALLOW_ENTRY_TYPE, { command: normalized });
    }
  });
}
