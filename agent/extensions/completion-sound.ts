/**
 * Completion sound extension - plays a subtle audio notification when agent finishes
 *
 * Inspired by Amp's finishing sound. Plays a system sound when the agent
 * completes its turn to provide subtle, non-intrusive feedback.
 *
 * Uses macOS system sounds by default (cross-platform support via afplay/paplay/powershell).
 * Toggle with: /sound
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let soundFile = "/System/Library/Sounds/Tink.aiff";

	pi.registerCommand("sound", {
		description: "Toggle completion sound notifications",
		handler: async (args, ctx) => {
			if (args.trim()) {
				soundFile = args.trim();
				ctx.ui.notify(`Sound file set to: ${soundFile}`, "info");
				return;
			}

			enabled = !enabled;
			ctx.ui.notify(enabled ? "Completion sound enabled" : "Completion sound disabled", "info");

			if (enabled) {
				playSound(soundFile);
			}
		},
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (enabled && ctx.hasUI) {
			playSound(soundFile);
		}
	});

	function playSound(file: string) {
		const platform = process.platform;

		try {
			if (platform === "darwin") {
				spawn("afplay", [file], { detached: true, stdio: "ignore" }).unref();
			} else if (platform === "linux") {
				spawn("paplay", [file], { detached: true, stdio: "ignore" }).unref();
			} else if (platform === "win32") {
				spawn("powershell", ["-c", `(New-Object Media.SoundPlayer '${file}').PlaySync()`], {
					detached: true,
					stdio: "ignore",
				}).unref();
			}
		} catch (err) {
			console.error("Failed to play completion sound:", err);
		}
	}
}
