import { homeDir } from "@tauri-apps/api/path";
import { DEFAULT_MODEL, LONG_REPLY_CHARS } from "$lib/config";

export type PermissionMode = "default" | "shell" | "all";

export interface ModelRef {
  providerID: string;
  id: string;
}

export interface Settings {
  directory: string;
  projects: string[];
  model: ModelRef;
  permissions: PermissionMode;
  /** Selected agent per project directory (unset = OpenCode's default). */
  agents: Record<string, string>;
  character: string;
  /** Bumped when characters are installed or removed, so open windows reload them. */
  characterRevision: number;
  /** App used for "continue in terminal"; empty uses the platform's default when available. */
  terminalApp: string;
  muted: boolean;
  longReplyChars: number;
}

const KEY = "chirp.settings";

let home = "";

const DEFAULTS: Settings = {
  // Filled with the home directory by initSettings() on first run.
  directory: "",
  projects: [],
  model: DEFAULT_MODEL,
  permissions: "default",
  agents: {},
  character: "default",
  characterRevision: 0,
  terminalApp: "",
  muted: false,
  longReplyChars: LONG_REPLY_CHARS,
};

function load(): Settings {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return { ...DEFAULTS, ...stored };
  } catch {
    return { ...DEFAULTS };
  }
}

class SettingsStore {
  s = $state<Settings>(load());

  constructor() {
    // Keep every window in sync.
    window.addEventListener("storage", (e) => {
      if (e.key === KEY) this.s = load();
    });
  }

  update(patch: Partial<Settings>) {
    this.s = { ...this.s, ...patch };
    localStorage.setItem(KEY, JSON.stringify(this.s));
  }

  addProject(dir: string) {
    this.update({ directory: dir, projects: [dir, ...this.s.projects.filter((p) => p !== dir)] });
  }

  setAgent(dir: string, agent: string) {
    this.update({ agents: { ...this.s.agents, [dir]: agent } });
  }

  removeProject(dir: string) {
    const projects = this.s.projects.filter((p) => p !== dir);
    this.update({
      projects,
      directory: this.s.directory === dir ? (projects[0] ?? home) : this.s.directory,
    });
  }
}

export const settings = new SettingsStore();

/** Resolve the home directory and use it as the default project on first run. Await before using settings. */
export async function initSettings() {
  home = (await homeDir()).replace(/\/+$/, "");
  const s = settings.s;
  if (!s.directory || !s.projects.length) {
    const directory = s.directory || home;
    settings.update({ directory, projects: s.projects.length ? s.projects : [directory] });
  }
}

export const basename = (dir: string) => dir.split("/").filter(Boolean).pop() ?? dir;
