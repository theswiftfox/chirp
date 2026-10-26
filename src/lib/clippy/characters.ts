import { invoke } from "@tauri-apps/api/core";
import type { AgentData } from "./player";

/** The built-in character, shipped with the app. Everything else is installed into the app data folder. */
export const DEFAULT_CHARACTER = "default";

export interface CharacterInfo {
  id: string;
  name: string;
  framesize: [number, number];
  sheet: [number, number];
  /** Sprite-sheet offsets of the rest pose layers, for thumbnails. */
  rest: number[][];
  source: "bundled" | "installed";
}

export interface LoadedCharacter {
  id: string;
  data: AgentData;
  sheetUrl: string;
  soundUrl: (name: string) => string | undefined;
  /** Release object URLs created for installed characters. */
  dispose: () => void;
}

const bundledBase = (id: string) => `/characters/${id}`;

/** Raw bytes of a file of an installed character (served by the Rust side). */
async function installedFile(id: string, path: string): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("character_file", { id, path });
}

export async function listCharacters(): Promise<CharacterInfo[]> {
  const meta = await fetch(`${bundledBase(DEFAULT_CHARACTER)}/meta.json`).then((r) => r.json());
  const installed = await invoke<Omit<CharacterInfo, "source">[]>("list_characters").catch(() => []);
  return [
    { ...meta, source: "bundled" },
    ...installed.filter((c) => c.id !== DEFAULT_CHARACTER).map((c) => ({ ...c, source: "installed" as const })),
  ];
}

/** A URL for the sprite sheet of any character, for thumbnails. Call `revoke` when done. */
export async function sheetUrlFor(c: CharacterInfo): Promise<{ url: string; revoke: () => void }> {
  if (c.source === "bundled") return { url: `${bundledBase(c.id)}/map.png`, revoke: () => {} };
  const url = URL.createObjectURL(new Blob([await installedFile(c.id, "map.png")], { type: "image/png" }));
  return { url, revoke: () => URL.revokeObjectURL(url) };
}

async function loadBundled(id: string): Promise<LoadedCharacter> {
  const base = bundledBase(id);
  const data = (await fetch(`${base}/agent.json`).then((r) => r.json())) as AgentData;
  return {
    id,
    data,
    sheetUrl: `${base}/map.png`,
    soundUrl: (name) => `${base}/sounds/${name}.mp3`,
    dispose: () => {},
  };
}

async function loadInstalled(id: string): Promise<LoadedCharacter> {
  const data = JSON.parse(new TextDecoder().decode(await installedFile(id, "agent.json"))) as AgentData & { sounds?: string[] };
  const urls: string[] = [];
  const blobUrl = (buf: ArrayBuffer, type: string) => {
    const url = URL.createObjectURL(new Blob([buf], { type }));
    urls.push(url);
    return url;
  };
  const sheetUrl = blobUrl(await installedFile(id, "map.png"), "image/png");
  const sounds = new Map<string, string>();
  await Promise.all(
    (data.sounds ?? []).map(async (name) => {
      try {
        sounds.set(name, blobUrl(await installedFile(id, `sounds/${name}.mp3`), "audio/mpeg"));
      } catch {
        // A missing sound is not worth failing the whole character for.
      }
    }),
  );
  return {
    id,
    data,
    sheetUrl,
    soundUrl: (name) => sounds.get(name),
    dispose: () => urls.forEach((u) => URL.revokeObjectURL(u)),
  };
}

/** Load a character; if it isn't available (e.g. the classic bundle was removed) use the default. */
export async function loadCharacter(id: string): Promise<LoadedCharacter> {
  if (id !== DEFAULT_CHARACTER) {
    try {
      return await loadInstalled(id);
    } catch (err) {
      console.warn(`character "${id}" is not available, using the default`, err);
    }
  }
  return loadBundled(DEFAULT_CHARACTER);
}
