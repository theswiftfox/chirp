import { invoke } from "@tauri-apps/api/core";
import type { Mood } from "$lib/clippy/behavior";
import { basename, settings, type PermissionMode } from "$lib/settings.svelte";
import {
  OpenCodeClient,
  type AgentInfo,
  type PermissionDecision,
  type PermissionRule,
  summarize,
  type ServerEvent,
  type SessionInfo,
} from "./client";

export const REPLY_KEY = "chirp.reply";
export const HISTORY_KEY = "chirp.history";
const BINDINGS_KEY = "chirp.sessions";

interface Session {
  id: string;
  running: boolean;
  stopped: boolean;
  mood: Mood;
  lastText: string;
  lastPrompt: string;
  retried: boolean;
  touched: number;
  /** Live activity of the current run: commentary and tool steps, in order. */
  feed: FeedItem[];
}

export interface FeedItem {
  kind: "text" | "tool";
  text: string;
  /** Tool call id, to update the step when it finishes. */
  id?: string;
  state?: "run" | "ok" | "fail";
}

/** The session Clippy uses for a project, plus the settings it was created with. */
interface Binding {
  id: string;
  perm: PermissionMode;
  model: string;
  agent?: string;
}

export interface PendingPermission {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
}

export interface Bubble {
  kind: "idle" | "info" | "text" | "stream" | "ready" | "error";
  text: string;
  /** Headline above the live feed while a run is in progress. */
  title?: string;
  feed?: FeedItem[];
  /** What the agent is doing right now (shown small under the feed). */
  status?: string;
}

const WORKING_TITLE = "Let me think about that…";

const SEARCH_TOOLS = /^(read|glob|grep|list|ls|find|search|webfetch|websearch|fetch)/i;
const WRITE_TOOLS = /^(edit|write|patch|apply_patch|multiedit)/i;

function toolMood(name: string): Mood {
  if (SEARCH_TOOLS.test(name)) return "searching";
  if (WRITE_TOOLS.test(name)) return "writing";
  if (/^(shell|bash|exec|run)/i.test(name)) return "working";
  return "checking";
}

function rulesFor(mode: PermissionMode): PermissionRule[] {
  if (mode === "shell") return [{ action: "shell", resource: "*", effect: "ask" }];
  if (mode === "all") return [{ action: "*", resource: "*", effect: "ask" }];
  return [];
}

function loadBindings(): Record<string, Binding> {
  try {
    return JSON.parse(localStorage.getItem(BINDINGS_KEY) ?? "{}");
  } catch {
    return {};
  }
}

export class OpenCodeStore {
  status = $state<"starting" | "ready" | "error">("starting");
  error = $state("");
  connected = $state(false);
  pending = $state<PendingPermission[]>([]);
  bubble = $state<Bubble>({ kind: "info", text: "Starting OpenCode…" });
  flash = $state<Mood | null>(null);
  agents = $state<AgentInfo[]>([]);
  sessionList = $state<SessionInfo[]>([]);
  /** Titles of sessions we know about, for the session chip. */
  titles = $state<Record<string, string>>({});

  private sessions = $state<Record<string, Session>>({});
  private bindings = $state<Record<string, Binding>>(loadBindings());
  private client?: OpenCodeClient;
  private stop?: () => void;
  private flashTimer?: ReturnType<typeof setTimeout>;

  mood = $derived.by<Mood>(() => {
    if (this.status === "error") return "error";
    if (this.pending.length) return "alert";
    if (this.flash) return this.flash;
    const running = Object.values(this.sessions)
      .filter((s) => s.running)
      .sort((a, b) => b.touched - a.touched);
    return running[0]?.mood ?? "idle";
  });

  currentSessionId = $derived(this.bindings[settings.s.directory]?.id);

  currentTitle = $derived(this.currentSessionId ? (this.titles[this.currentSessionId] ?? "Current chat") : "New chat");

  currentAgent = $derived(settings.s.agents[settings.s.directory] ?? "");

  /** Hand over to the terminal only between prompts: nothing running, nothing waiting on a permission. */
  canHandover = $derived.by(() => {
    const id = this.currentSessionId;
    return this.status === "ready" && !!id && !this.busy && !this.pending.some((p) => p.sessionID === id);
  });

  /** Is the session of the current project working right now? */
  busy = $derived.by(() => {
    const b = this.bindings[settings.s.directory];
    return !!(b && this.sessions[b.id]?.running);
  });

  async start() {
    try {
      const info = await invoke<{ url: string; password: string }>("start_server");
      this.client = new OpenCodeClient(info.url, info.password);
      this.stop = this.client.subscribe(
        (e) => this.handle(e),
        (c) => (this.connected = c),
      );
      this.status = "ready";
      this.greet();
      this.loadAgents();
    } catch (err) {
      this.status = "error";
      this.error = String(err);
      this.bubble = { kind: "error", text: `Couldn't start OpenCode: ${this.error}` };
    }
  }

  dispose() {
    this.stop?.();
  }

  projectOf(sessionID: string): string {
    const dir = Object.keys(this.bindings).find((d) => this.bindings[d].id === sessionID);
    return dir ? basename(dir) : "";
  }

  private greet() {
    this.bubble = {
      kind: "idle",
      text: `It looks like you're working in ${basename(settings.s.directory)}. What can I help with?`,
    };
  }

  setProject(dir: string) {
    settings.addProject(dir);
    if (!this.busy) this.greet();
    this.loadAgents();
  }

  async loadAgents() {
    const dir = settings.s.directory;
    try {
      const list = (await this.client?.listAgents(dir)) ?? [];
      if (dir === settings.s.directory) this.agents = list;
    } catch (err) {
      console.warn("could not load agents", err);
    }
  }

  async loadSessions() {
    try {
      const list = (await this.client?.listSessions(settings.s.directory)) ?? [];
      this.sessionList = list;
      for (const s of list) this.titles[s.id] = s.title;
    } catch (err) {
      console.warn("could not load sessions", err);
    }
  }

  setAgent(id: string) {
    settings.setAgent(settings.s.directory, id);
    const name = this.agents.find((a) => a.id === id)?.name ?? id;
    this.bubble = { kind: "idle", text: `Okay, ${name} is on the job.` };
  }

  /** Continue an existing session of the current project. */
  async switchSession(info: SessionInfo) {
    const dir = settings.s.directory;
    const st = settings.s;
    this.bindings[dir] = {
      id: info.id,
      perm: st.permissions,
      model: `${st.model.providerID}/${st.model.id}`,
      agent: info.agent,
    };
    this.titles[info.id] = info.title;
    this.saveBindings();
    if (info.agent && info.agent !== st.agents[dir]) settings.setAgent(dir, info.agent);
    this.bubble = { kind: "info", text: `Back to "${info.title}".` };
    try {
      const { prompt, reply } = await this.client!.lastExchange(info.id);
      if (this.currentSessionId !== info.id) return;
      if (!reply) return;
      localStorage.setItem(
        REPLY_KEY,
        JSON.stringify({ prompt, text: reply, project: basename(dir), time: Date.now(), sessionID: info.id, title: info.title }),
      );
      this.bubble =
        reply.length > st.longReplyChars
          ? { kind: "ready", text: `Last time in "${info.title}": the result is ready.` }
          : { kind: "text", text: reply };
    } catch (err) {
      console.warn("could not load last reply", err);
    }
  }

  newSession() {
    const dir = settings.s.directory;
    delete this.bindings[dir];
    this.saveBindings();
    this.bubble = { kind: "idle", text: `Fresh start in ${basename(dir)}! What are we doing?` };
  }

  async send(text: string) {
    if (!this.client || !text.trim()) return;
    try {
      const { session: s, created } = await this.ensureSession();
      if (created) {
        const title = text.trim().replace(/\s+/g, " ").slice(0, 48);
        this.titles[s.id] = title;
        this.client.renameSession(s.id, title).catch(() => {});
      }
      s.lastPrompt = text;
      s.feed = [];
      s.retried = false;
      s.stopped = false;
      s.running = true;
      s.mood = "thinking";
      s.touched = Date.now();
      this.bubble = { kind: "stream", text: "", title: WORKING_TITLE, feed: s.feed, status: "" };
      try {
        await this.client.prompt(s.id, text);
      } catch (err) {
        if (!String(err).includes("404")) throw err;
        // The stored session no longer exists on the server: start over once.
        delete this.bindings[settings.s.directory];
        const { session: fresh } = await this.ensureSession();
        fresh.lastPrompt = text;
        fresh.running = true;
        fresh.mood = "thinking";
        await this.client.prompt(fresh.id, text);
      }
    } catch (err) {
      this.fail(String(err));
    }
  }

  /** Open the activity/conversation window for the current session. */
  async openHistory() {
    const id = this.currentSessionId;
    if (!id) return;
    localStorage.setItem(
      HISTORY_KEY,
      JSON.stringify({ sessionID: id, title: this.titles[id] ?? "Current chat", project: basename(settings.s.directory) }),
    );
    await invoke("open_history").catch((err) => this.fail(String(err)));
  }

  /** Open the terminal TUI attached to our server on the current session. */
  async handover() {
    const id = this.currentSessionId;
    if (!id || !this.canHandover) return;
    try {
      await invoke("open_in_terminal_cmd", {
        directory: settings.s.directory,
        sessionId: id,
        terminal: settings.s.terminalApp || null,
      });
      this.bubble = { kind: "info", text: "Opened in your terminal. I'll keep an eye on things from here." };
    } catch (err) {
      this.fail(`Couldn't open the terminal: ${err}`);
    }
  }

  async answer(p: PendingPermission, decision: PermissionDecision) {
    this.pending = this.pending.filter((x) => x.id !== p.id);
    try {
      await this.client?.replyPermission(p.sessionID, p.id, decision);
    } catch (err) {
      this.fail(String(err));
    }
  }

  async interrupt() {
    const b = this.bindings[settings.s.directory];
    if (!b) return;
    const s = this.sessions[b.id];
    if (s) {
      s.running = false;
      s.stopped = true;
      s.mood = "idle";
    }
    this.pending = this.pending.filter((p) => p.sessionID !== b.id);
    this.bubble = { kind: "info", text: "Okay, I stopped." };
    clearTimeout(this.flashTimer);
    this.flash = null;
    await this.client?.interrupt(b.id).catch(() => {});
  }

  private async ensureSession(): Promise<{ session: Session; created: boolean }> {
    const client = this.client!;
    const st = settings.s;
    const dir = st.directory;
    const modelKey = `${st.model.providerID}/${st.model.id}`;
    const agent = st.agents[dir] || undefined;
    let b = this.bindings[dir];
    let created = false;

    if (!b || b.perm !== st.permissions) {
      const made = await client.createSession(dir, {
        model: st.model,
        title: "Chirp",
        agent,
        permissions: rulesFor(st.permissions),
      });
      b = { id: made.id, perm: st.permissions, model: modelKey, agent };
      created = true;
    } else {
      if (b.model !== modelKey) {
        await client.switchModel(b.id, st.model);
        b = { ...b, model: modelKey };
      }
      if (agent && b.agent !== agent) {
        await client.switchAgent(b.id, agent);
        b = { ...b, agent };
      }
    }
    this.bindings[dir] = b;
    this.saveBindings();
    return { session: this.sess(b.id), created };
  }

  private saveBindings() {
    localStorage.setItem(BINDINGS_KEY, JSON.stringify(this.bindings));
  }

  private sess(id: string): Session {
    return (this.sessions[id] ??= {
      id,
      running: false,
      stopped: false,
      mood: "idle",
      lastText: "",
      lastPrompt: "",
      retried: false,
      touched: Date.now(),
      feed: [],
    });
  }

  private setFlash(mood: Mood, ms = 4000) {
    clearTimeout(this.flashTimer);
    this.flash = mood;
    this.flashTimer = setTimeout(() => (this.flash = null), ms);
  }

  private fail(message: string) {
    this.bubble = { kind: "error", text: message };
    this.setFlash("error");
  }

  private handle(e: ServerEvent) {
    const d = e.data ?? {};
    const sid: string | undefined = d.sessionID;

    if (e.type === "permission.asked") {
      this.pending = [...this.pending, { id: d.id, sessionID: d.sessionID, action: d.action, resources: d.resources ?? [] }];
      return;
    }
    if (!sid || !e.type.startsWith("session.")) return;
    const s = this.sess(sid);
    if (s.stopped) return;
    s.touched = Date.now();

    switch (e.type) {
      case "session.execution.started":
        s.running = true;
        s.mood = "thinking";
        break;
      case "session.step.started":
        s.mood = "thinking";
        break;
      case "session.reasoning.started":
        s.mood = "thinking";
        this.live(s, "Thinking…");
        break;
      case "session.text.started":
        s.mood = "writing";
        s.feed.push({ kind: "text", text: "" });
        this.live(s, "");
        break;
      case "session.text.delta": {
        const last = s.feed.at(-1);
        if (last?.kind === "text") last.text += d.delta ?? "";
        else s.feed.push({ kind: "text", text: d.delta ?? "" });
        this.live(s);
        break;
      }
      case "session.text.ended": {
        s.lastText = d.text ?? s.lastText;
        const last = s.feed.at(-1);
        if (last?.kind === "text" && d.text) last.text = d.text;
        break;
      }
      case "session.tool.input.started":
        s.mood = toolMood(String(d.name ?? ""));
        s.feed.push({ kind: "tool", id: d.id, text: String(d.name ?? "tool"), state: "run" });
        this.live(s, "");
        break;
      case "session.tool.called": {
        const item = s.feed.find((i) => i.id === d.id);
        const detail = summarize(d.input);
        if (item && detail) item.text = `${item.text.split(":")[0]}: ${detail}`;
        this.live(s);
        break;
      }
      case "session.tool.success":
      case "session.tool.failed": {
        s.mood = "thinking";
        const item = s.feed.find((i) => i.id === d.id);
        if (item) item.state = e.type === "session.tool.success" ? "ok" : "fail";
        this.live(s, "");
        break;
      }
      case "session.execution.succeeded":
        s.running = false;
        this.finish(s);
        break;
      case "session.execution.failed":
        this.executionFailed(s, d.error);
        break;
    }
  }

  /** Refresh the live bubble, if this is the session being watched. */
  private live(s: Session, status?: string) {
    if (this.bindings[settings.s.directory]?.id !== s.id) return;
    this.bubble = {
      kind: "stream",
      text: "",
      title: WORKING_TITLE,
      feed: s.feed,
      status: status ?? this.bubble.status,
    };
  }

  private finish(s: Session) {
    const text = s.lastText.trim();
    const project = this.projectOf(s.id);
    const other = project && project !== basename(settings.s.directory);
    localStorage.setItem(REPLY_KEY, JSON.stringify({ prompt: s.lastPrompt, text, project, time: Date.now(), sessionID: s.id, title: this.titles[s.id] }));
    if (!text) this.bubble = { kind: "info", text: other ? `Finished in ${project}!` : "All done!" };
    else if (text.length > settings.s.longReplyChars) {
      this.bubble = { kind: "ready", text: other ? `The result for ${project} is ready!` : "The result is ready!" };
    } else this.bubble = { kind: "text", text: other ? `(${project}) ${text}` : text };
    s.lastText = "";
    s.feed = [];
    this.setFlash("done");
  }

  private executionFailed(s: Session, error: any) {
    const is401 = error?.type === "provider.auth" && error?.status === 401;
    if (is401 && !s.retried && s.lastPrompt) {
      // GHE token warm-up: the first request of a fresh server often 401s, the retry works.
      s.retried = true;
      s.mood = "thinking";
      setTimeout(() => this.client?.prompt(s.id, s.lastPrompt).catch((err) => this.fail(String(err))), 600);
      return;
    }
    s.running = false;
    this.fail(`Oops: ${error?.message ?? "something went wrong"}`);
  }
}
