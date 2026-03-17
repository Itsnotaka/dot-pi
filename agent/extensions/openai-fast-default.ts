import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type Payload = {
  service_tier?: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export default function (pi: ExtensionAPI) {
  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.provider !== "openai") {
      return;
    }

    if (!isObject(event.payload)) {
      return;
    }

    const payload = event.payload as Payload;

    if (payload.service_tier === "priority") {
      return payload;
    }

    return {
      ...payload,
      service_tier: "priority",
    };
  });
}
