// Explicit model: a fresh server's default model picks a Copilot model that may not be enabled.
export const DEFAULT_MODEL = { providerID: "github-copilot", id: "claude-haiku-5.5" };

// Replies longer than this show "result is ready" instead of the full text.
export const LONG_REPLY_CHARS = 220;
