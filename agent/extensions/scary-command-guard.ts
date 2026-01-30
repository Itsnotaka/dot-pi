import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const scaryPatterns: { pattern: RegExp; label: string }[] = [
	// Destructive file operations
	{ pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s|.*-rf\b|.*--recursive\b)/, label: "Recursive delete" },
	{ pattern: /\brm\s+-[a-zA-Z]*f/, label: "Force delete" },
	{ pattern: /\bmkfs\b/, label: "Format filesystem" },
	{ pattern: /\bdd\b\s+/, label: "Disk write (dd)" },

	// Git push / force operations
	{ pattern: /\bgit\s+push\b/, label: "Git push" },
	{ pattern: /\bgit\s+push\s+.*--force/, label: "Git force push" },
	{ pattern: /\bgit\s+push\s+.*-f\b/, label: "Git force push" },
	{ pattern: /\bgit\s+reset\s+--hard\b/, label: "Git hard reset" },
	{ pattern: /\bgit\s+clean\s+-[a-zA-Z]*f/, label: "Git clean" },
	{ pattern: /\bgit\s+checkout\s+--\s*\./, label: "Git discard all changes" },

	// Deploy / publish (JS, Python, Ruby, Rust, Go, PHP, Deno, Elixir, .NET)
	{ pattern: /\b(npm|pnpm|yarn|bun)\s+publish\b/, label: "Package publish" },
	{ pattern: /\btwine\s+upload\b/, label: "PyPI publish" },
	{ pattern: /\bgem\s+push\b/, label: "RubyGems publish" },
	{ pattern: /\bcargo\s+publish\b/, label: "Cargo publish" },
	{ pattern: /\bdeno\s+publish\b/, label: "Deno publish" },
	{ pattern: /\bjsr\s+publish\b/, label: "JSR publish" },
	{ pattern: /\bcomposer\s+.*publish\b/, label: "Composer publish" },
	{ pattern: /\bmix\s+hex\.publish\b/, label: "Hex publish" },
	{ pattern: /\bdotnet\s+nuget\s+push\b/, label: "NuGet publish" },
	{ pattern: /\bpod\s+trunk\s+push\b/, label: "CocoaPods publish" },
	{ pattern: /\bdeploy\b/, label: "Deploy" },
	{ pattern: /\bterraform\s+(apply|destroy)\b/, label: "Terraform mutation" },
	{ pattern: /\bpulumi\s+(up|destroy)\b/, label: "Pulumi mutation" },
	{ pattern: /\bkubectl\s+(apply|delete|rollout)\b/, label: "Kubectl mutation" },
	{ pattern: /\bhelm\s+(install|upgrade|uninstall)\b/, label: "Helm mutation" },
	{ pattern: /\baws\s+.*\b(delete|terminate|destroy)\b/, label: "AWS destructive" },

	// Elevated / system
	{ pattern: /\bsudo\b/, label: "Elevated privileges" },
	{ pattern: /\bchmod\s+777\b/, label: "Open permissions" },
	{ pattern: /\bchown\b/, label: "Change ownership" },

	// Database
	{ pattern: /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i, label: "SQL DROP" },
	{ pattern: /\bTRUNCATE\b/i, label: "SQL TRUNCATE" },
	{ pattern: /\bDELETE\s+FROM\b/i, label: "SQL DELETE" },

	// Long-running / blocking
	{ pattern: /\bdocker\s+compose\s+up\b(?!.*-d)/, label: "Docker compose (foreground)" },

	// Pipe to shell
	{ pattern: /\bcurl\b.*\|\s*(ba)?sh\b/, label: "Pipe to shell" },
	{ pattern: /\bwget\b.*\|\s*(ba)?sh\b/, label: "Pipe to shell" },
];

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return;

		const cmd = (event.input as Record<string, unknown>).command as string;
		if (!cmd) return;

		const matches = scaryPatterns.filter(({ pattern }) => pattern.test(cmd));
		if (matches.length === 0) return;

		const labels = [...new Set(matches.map((m) => m.label))];
		const tag = labels.join(", ");

		const approved = await ctx.ui.confirm("⚠️ " + tag, cmd);

		if (!approved) {
			return { block: true, reason: `User rejected command (${tag})` };
		}
	});
}
