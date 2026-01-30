/**
 * Completion sound extension - plays context-aware audio notifications
 *
 * Matches Amp's sound behavior with three scenarios:
 * 1. idle - Agent completes work (Submarine.aiff)
 * 2. idle-review - Code review finished (Glass.aiff)
 * 3. requires-user-input - Tool needs approval (Ping.aiff)
 *
 * Only plays when configured and follows Amp's notification patterns.
 * Toggle with: /sound
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { exec } from "node:child_process";

export default function (pi: ExtensionAPI) {
  let enabled = true;
  let wasProcessing = false;

  pi.registerCommand("sound", {
    description: "Toggle completion sound notifications",
    handler: async (_args, ctx) => {
      enabled = !enabled;
      ctx.ui.notify(
        enabled ? "Completion sounds enabled" : "Completion sounds disabled",
        "info"
      );

      if (enabled) {
        playSound("idle");
      }
    },
  });

  pi.on("agent_start", async (_event, _ctx) => {
    wasProcessing = true;
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!enabled || !ctx.hasUI) return;

    if (wasProcessing) {
      playSound("idle");
      wasProcessing = false;
    }
  });

  function playSound(scenario: "idle" | "idle-review" | "requires-user-input") {
    try {
      if (process.platform === "darwin") {
        const sounds = {
          idle: "/System/Library/Sounds/Submarine.aiff",
          "idle-review": "/System/Library/Sounds/Glass.aiff",
          "requires-user-input": "/System/Library/Sounds/Ping.aiff",
        };
        exec(`afplay ${sounds[scenario]}`);
      } else if (process.platform === "win32") {
        const beeps = {
          idle: "[console]::beep(800,200)",
          "idle-review": "[console]::beep(900,200)",
          "requires-user-input": "[console]::beep(1000,300)",
        };
        exec(`powershell ${beeps[scenario]}`);
      } else if (process.platform === "linux") {
        const sounds = {
          idle: "paplay /usr/share/sounds/freedesktop/stereo/message.oga || beep",
          "idle-review":
            "paplay /usr/share/sounds/freedesktop/stereo/complete.oga || beep",
          "requires-user-input":
            "paplay /usr/share/sounds/freedesktop/stereo/dialog-information.oga || beep -f 1000 -l 100",
        };
        exec(sounds[scenario]);
      }
    } catch (err) {
      console.error(`Failed to play ${scenario} sound:`, err);
    }
  }
}
