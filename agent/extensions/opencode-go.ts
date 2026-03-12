import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@mariozechner/pi-ai";

const AUTH_URL = "https://opencode.ai/auth";
const NEVER_EXPIRES = 253402300799000;

const MODELS: Array<{
  id: string;
  name: string;
  api: "openai-completions";
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
}> = [
  {
    id: "glm-5",
    name: "GLM-5",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 1,
      output: 3.2,
      cacheRead: 0.2,
      cacheWrite: 0,
    },
    contextWindow: 204800,
    maxTokens: 131072,
  },
  {
    id: "kimi-k2.5",
    name: "Kimi K2.5",
    api: "openai-completions",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.6,
      output: 3,
      cacheRead: 0.1,
      cacheWrite: 0,
    },
    contextWindow: 262144,
    maxTokens: 65536,
  },
];

async function loginOpenCodeGo(
  callbacks: OAuthLoginCallbacks
): Promise<OAuthCredentials> {
  callbacks.onAuth({
    url: AUTH_URL,
    instructions: "Log in and copy your API key",
  });

  const apiKey = await callbacks.onPrompt({
    message: "Paste your OpenCode API key",
    placeholder: "sk-...",
  });

  const access = apiKey.trim();
  if (!access) throw new Error("API key is required");

  return {
    access,
    refresh: access,
    expires: NEVER_EXPIRES,
  };
}

async function refreshOpenCodeGoToken(
  credentials: OAuthCredentials
): Promise<OAuthCredentials> {
  return {
    ...credentials,
    expires: NEVER_EXPIRES,
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerProvider("opencode-go", {
    baseUrl: "https://opencode.ai/zen/go/v1",
    apiKey: "OPENCODE_API_KEY",
    models: MODELS.map((model) => ({ ...model })),
    oauth: {
      name: "OpenCode Go",
      login: loginOpenCodeGo,
      refreshToken: refreshOpenCodeGoToken,
      getApiKey: (credentials) => credentials.access,
    },
  });
}
