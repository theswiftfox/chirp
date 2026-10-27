import { fetch } from "@tauri-apps/plugin-http";

export interface ServerEvent {
  id?: string;
  type: string;
  data?: any;
  location?: { directory: string };
}

export interface PermissionRule {
  action: string;
  resource: string;
  effect: "allow" | "deny" | "ask";
}

export interface SessionInfo {
  id: string;
  title: string;
  agent?: string;
  updated: number;
}

export interface AgentInfo {
  id: string;
  name: string;
  description: string;
}

export interface ConversationItem {
  kind: "user" | "text" | "tool" | "thinking";
  text: string;
  state?: "run" | "ok" | "fail";
}

export function summarize(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  const v = o.command ?? o.path ?? o.filePath ?? o.pattern ?? o.url ?? o.query ?? Object.values(o).find((x) => typeof x === "string");
  return typeof v === "string" ? v.replace(/\s+/g, " ").slice(0, 70) : "";
}

const CONVERSATION_PAGE = 200;

export type PermissionDecision = "once" | "always" | "reject";

export class OpenCodeClient {
  private auth: string;
  private abort = new AbortController();

  constructor(
    private baseUrl: string,
    password: string,
  ) {
    this.auth = "Basic " + btoa(`opencode:${password}`);
  }

  private async req(method: string, path: string, body?: unknown) {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: {
        authorization: this.auth,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  async createSession(
    directory: string,
    opts: {
      model?: { providerID: string; id: string };
      title?: string;
      agent?: string;
      permissions?: PermissionRule[];
    } = {},
  ) {
    const r = await this.req("POST", "/api/session", {
      title: opts.title,
      location: { directory },
      model: opts.model,
      agent: opts.agent,
      permissions: opts.permissions?.length ? opts.permissions : undefined,
    });
    return r.data as { id: string };
  }

  switchModel(sessionID: string, model: { providerID: string; id: string }) {
    return this.req("POST", `/api/session/${sessionID}/model`, { model });
  }

  switchAgent(sessionID: string, agent: string) {
    return this.req("POST", `/api/session/${sessionID}/agent`, { agent });
  }

  renameSession(sessionID: string, title: string) {
    return this.req("PATCH", `/api/session/${sessionID}`, { title });
  }

  /** Top-level (non-child) sessions of a project, newest first. */
  async listSessions(directory: string): Promise<SessionInfo[]> {
    const r = await this.req("GET", `/api/session?directory=${encodeURIComponent(directory)}&limit=40`);
    return ((r.data ?? []) as any[])
      .filter((s) => !s.parentID && !s.time?.archived)
      .map((s) => ({
        id: s.id,
        title: s.title || "Untitled",
        agent: s.agent,
        updated: s.time?.updated ?? 0,
      }))
      .sort((a, b) => b.updated - a.updated);
  }

  /** Agents available in a project, including its own .opencode agents. */
  async listAgents(directory: string): Promise<AgentInfo[]> {
    const r = await this.req("GET", `/api/agent?location%5Bdirectory%5D=${encodeURIComponent(directory)}`);
    return ((r.data ?? []) as any[])
      .filter((a) => a.mode !== "subagent" && !a.hidden)
      .map((a) => ({ id: a.id, name: a.name ?? a.id, description: a.description ?? "" }));
  }

  /** The last user prompt and assistant reply of a session. */
  async lastExchange(sessionID: string): Promise<{ prompt: string; reply: string }> {
    const r = await this.req("GET", `/api/session/${sessionID}/message?limit=20&order=desc`);
    const msgs = (r.data ?? []) as any[];
    const text = (m: any) =>
      ((m.content ?? []) as any[])
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n")
        .trim();
    const reply = msgs.filter((m) => m.type === "assistant").map(text).find(Boolean) ?? "";
    const prompt = msgs.find((m) => m.type === "user")?.text ?? "";
    return { prompt, reply };
  }

  /** One page of a conversation, flattened to prompts, replies and tool steps. Pass `cursor` for the page before it. */
  async conversation(
    sessionID: string,
    cursor?: string,
  ): Promise<{ items: ConversationItem[]; cursor: string; more: boolean }> {
    const r = await this.req(
      "GET",
      `/api/session/${sessionID}/message?limit=${CONVERSATION_PAGE}&order=desc` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""),
    );
    const msgs = ((r.data ?? []) as any[]).reverse();
    const items: ConversationItem[] = [];
    for (const m of msgs) {
      if (m.type === "user") {
        if (m.text) items.push({ kind: "user", text: m.text });
      } else if (m.type === "assistant") {
        for (const c of (m.content ?? []) as any[]) {
          if (c.type === "text" && c.text?.trim()) items.push({ kind: "text", text: c.text });
          else if (c.type === "reasoning") items.push({ kind: "thinking", text: "Thinking…" });
          else if (c.type === "tool") {
            const status = c.state?.status;
            const detail = summarize(c.state?.input);
            items.push({
              kind: "tool",
              text: detail ? `${c.name}: ${detail}` : String(c.name ?? "tool"),
              state: status === "completed" ? "ok" : status === "error" || status === "failed" ? "fail" : "run",
            });
          }
        }
      }
    }
    return { items, cursor: r.cursor?.next ?? "", more: msgs.length >= CONVERSATION_PAGE && !!r.cursor?.next };
  }

  async listModels() {
    const r = await this.req("GET", "/api/model");
    return (r.data ?? []) as { id: string; providerID: string; name?: string }[];
  }

  prompt(sessionID: string, text: string) {
    return this.req("POST", `/api/session/${sessionID}/prompt`, { text });
  }

  interrupt(sessionID: string) {
    return this.req("POST", `/api/session/${sessionID}/interrupt`, {});
  }

  replyPermission(sessionID: string, requestID: string, decision: PermissionDecision) {
    return this.req("POST", `/api/session/${sessionID}/permission/${requestID}/reply`, { decision });
  }

  /** Long-lived SSE subscription with automatic reconnect. Returns a stop function. */
  subscribe(onEvent: (e: ServerEvent) => void, onStatus?: (connected: boolean) => void) {
    const run = async () => {
      let delay = 500;
      while (!this.abort.signal.aborted) {
        try {
          const res = await fetch(this.baseUrl + "/api/event", {
            headers: { authorization: this.auth, accept: "text/event-stream" },
            signal: this.abort.signal,
          });
          if (!res.ok || !res.body) throw new Error(`event stream ${res.status}`);
          onStatus?.(true);
          delay = 500;
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let i: number;
            while ((i = buf.indexOf("\n\n")) >= 0) {
              const chunk = buf.slice(0, i);
              buf = buf.slice(i + 2);
              for (const line of chunk.split("\n")) {
                if (!line.startsWith("data: ")) continue;
                try {
                  onEvent(JSON.parse(line.slice(6)));
                } catch (err) {
                  console.warn("bad event", err);
                }
              }
            }
          }
        } catch (err) {
          if (this.abort.signal.aborted) return;
          console.warn("event stream error", err);
        }
        onStatus?.(false);
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 5000);
      }
    };
    run();
    return () => this.abort.abort();
  }
}
