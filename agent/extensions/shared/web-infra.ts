import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const SETTINGS_PATH = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "settings.json"
);

export const SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;

export const SPINNER_INTERVAL_MS = 80;

type ToolConfig = Record<string, unknown>;

type SettingsRecord = Record<string, unknown>;

function readSettings(): SettingsRecord | null {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed as SettingsRecord;
    }
  } catch {
    return null;
  }
  return null;
}

function readToolConfig(tool: string): ToolConfig | null {
  const settings = readSettings();
  if (!settings) return null;
  const value = settings[tool];
  if (!value || typeof value !== "object") return null;
  return value as ToolConfig;
}

export function resolveSettingString(
  tool: string,
  key: string,
  envVar?: string
): string | null {
  if (envVar) {
    const envValue = process.env[envVar];
    if (typeof envValue === "string" && envValue.trim()) {
      return envValue.trim();
    }
  }

  const config = readToolConfig(tool);
  const value = config?.[key];
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  return null;
}

export function resolveApiKey(tool: string, envVar?: string): string | null {
  return resolveSettingString(tool, "apiKey", envVar);
}

export function getSpinnerFrame(index: number): string {
  return SPINNER_FRAMES[index % SPINNER_FRAMES.length] ?? "⠋";
}

export function createSpinnerTicker(
  enabled: boolean,
  onTick: (spinnerIndex: number) => void,
  signal?: AbortSignal,
  intervalMs: number = SPINNER_INTERVAL_MS
): () => void {
  if (!enabled) {
    return () => {};
  }

  let spinnerIndex = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  const tick = () => {
    onTick(spinnerIndex);
    spinnerIndex = (spinnerIndex + 1) % SPINNER_FRAMES.length;
  };

  tick();
  timer = setInterval(tick, intervalMs);

  const stop = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    signal?.removeEventListener("abort", stop);
  };

  signal?.addEventListener("abort", stop, { once: true });
  return stop;
}
