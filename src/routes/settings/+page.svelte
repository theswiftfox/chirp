<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import { ask, open } from "@tauri-apps/plugin-dialog";
  import { listCharacters, sheetUrlFor, DEFAULT_CHARACTER, type CharacterInfo } from "$lib/clippy/characters";
  import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
  import { OpenCodeClient } from "$lib/opencode/client";
  import { basename, initSettings, settings, type PermissionMode } from "$lib/settings.svelte";

  let characters = $state<CharacterInfo[]>([]);
  let thumbs = $state<Record<string, string>>({});
  let revokers: (() => void)[] = [];
  let busy = $state(false);
  let iconStatus = $state({ style: "paperclip", clippy_available: false });

  async function refreshIcon() {
    iconStatus = await invoke("icon_status");
  }

  async function setIconStyle(style: string) {
    try {
      iconStatus = await invoke("set_icon_style", { style });
    } catch (err) {
      installError = String(err);
      await refreshIcon();
    }
  }
  let progress = $state({ message: "", value: 0 });
  let installError = $state("");

  const thumbScale = (c: CharacterInfo) => Math.min(64 / c.framesize[0], 64 / c.framesize[1]);
  const hasClassics = $derived(characters.some((c) => c.source === "installed"));

  async function refreshCharacters() {
    revokers.forEach((r) => r());
    revokers = [];
    thumbs = {};
    characters = await listCharacters();
    for (const c of characters) {
      sheetUrlFor(c)
        .then(({ url, revoke }) => {
          revokers.push(revoke);
          thumbs[c.id] = url;
        })
        .catch((err) => console.warn("no thumbnail for", c.id, err));
    }
  }

  async function installClassics() {
    const ok = await ask(
      "Clippy, Rocky, Merlin and the other Office characters are Microsoft's artwork. They are not part of Chirp or " +
        "its licence.\n\nThis downloads the community 'clippyjs' package from npm and converts the characters on this " +
        "computer, for your personal use. Do not redistribute them.\n\nInstall them?",
      { title: "Install the classic characters", kind: "info", okLabel: "Install", cancelLabel: "Cancel" },
    );
    if (!ok) return;
    busy = true;
    installError = "";
    progress = { message: "Starting…", value: 0 };
    const stop = await listen<{ stage: string; progress: number; message: string }>("bundle-progress", (e) => {
      progress = { message: e.payload.message, value: e.payload.progress };
    });
    try {
      await invoke("install_clippy_bundle");
      settings.update({ characterRevision: Date.now() });
      await refreshCharacters();
      await refreshIcon();
    } catch (err) {
      installError = String(err);
    } finally {
      stop();
      busy = false;
    }
  }

  async function removeClassics() {
    const ok = await ask("Remove the classic characters from this computer? You can install them again later.", {
      title: "Remove the classic characters",
      kind: "warning",
      okLabel: "Remove",
      cancelLabel: "Cancel",
    });
    if (!ok) return;
    busy = true;
    try {
      await invoke("remove_installed_characters");
      if (settings.s.character !== DEFAULT_CHARACTER) settings.update({ character: DEFAULT_CHARACTER });
      settings.update({ characterRevision: Date.now() });
      await refreshCharacters();
      await refreshIcon();
    } catch (err) {
      installError = String(err);
    } finally {
      busy = false;
    }
  }

  onDestroy(() => revokers.forEach((r) => r()));

  let models = $state<{ id: string; providerID: string; name?: string }[]>([]);
  let modelError = $state("");
  let autostart = $state(false);

  const byProvider = $derived.by(() => {
    const groups: Record<string, typeof models> = {};
    for (const m of models) (groups[m.providerID] ??= []).push(m);
    return Object.entries(groups);
  });

  const modelValue = $derived(`${settings.s.model.providerID}/${settings.s.model.id}`);

  function setModel(value: string) {
    const i = value.indexOf("/");
    settings.update({ model: { providerID: value.slice(0, i), id: value.slice(i + 1) } });
  }

  async function addFolder() {
    const dir = await open({ directory: true, multiple: false, defaultPath: settings.s.directory });
    if (typeof dir === "string") settings.addProject(dir);
  }

  async function toggleAutostart(on: boolean) {
    try {
      if (on) await enable();
      else await disable();
    } finally {
      autostart = await isEnabled();
    }
  }

  onMount(async () => {
    initSettings();
    isEnabled().then((v) => (autostart = v));
    refreshIcon().catch((err) => console.warn("could not read the icon style", err));
    refreshCharacters().catch((err) => console.warn("could not load characters", err));
    try {
      const info = await invoke<{ url: string; password: string }>("start_server");
      models = await new OpenCodeClient(info.url, info.password).listModels();
    } catch (err) {
      modelError = String(err);
    }
  });
</script>

<svelte:head><title>Chirp Settings</title></svelte:head>

<div class="page">
  <h1>Settings</h1>

  <section>
    <h2>Character</h2>
    <div class="chars">
      {#each characters as c (c.id)}
        {@const sc = thumbScale(c)}
        <button class="char" class:selected={settings.s.character === c.id} onclick={() => settings.update({ character: c.id })}>
          <div class="thumb" style:width="{c.framesize[0] * sc}px" style:height="{c.framesize[1] * sc}px">
            {#each c.rest as pos}
              <div
                class="layer"
                style:background-image={thumbs[c.id] ? `url(${thumbs[c.id]})` : "none"}
                style:background-size="{c.sheet[0] * sc}px {c.sheet[1] * sc}px"
                style:background-position="-{pos[0] * sc}px -{pos[1] * sc}px"
              ></div>
            {/each}
          </div>
          <span>{c.name}</span>
        </button>
      {/each}
    </div>

    <div class="classics">
      {#if hasClassics}
        <span class="hint">The classic Office characters are installed.</span>
        <button disabled={busy} onclick={removeClassics}>Remove</button>
      {:else}
        <span class="hint">Want Clippy, Rocky, Merlin and friends? They're Microsoft's artwork, so they're an optional download.</span>
        <button disabled={busy} onclick={installClassics}>Install classic characters…</button>
      {/if}
    </div>
    {#if busy && progress.message}
      <progress max="1" value={progress.value}></progress>
      <p class="hint">{progress.message}</p>
    {/if}
    {#if installError}
      <p class="err">{installError}</p>
    {/if}
  </section>

  <section>
    <h2>Model</h2>
    {#if modelError}
      <p class="err">Couldn't load models: {modelError}</p>
    {/if}
    <select value={modelValue} onchange={(e) => setModel(e.currentTarget.value)}>
      {#if !models.some((m) => `${m.providerID}/${m.id}` === modelValue)}
        <option value={modelValue}>{modelValue}</option>
      {/if}
      {#each byProvider as [provider, list] (provider)}
        <optgroup label={provider}>
          {#each list as m (m.id)}
            <option value={`${provider}/${m.id}`}>{m.name ?? m.id}</option>
          {/each}
        </optgroup>
      {/each}
    </select>
    <p class="hint">Applies to the next prompt, and keeps the current conversation.</p>
  </section>

  <section>
    <h2>Permissions</h2>
    <select
      value={settings.s.permissions}
      onchange={(e) => settings.update({ permissions: e.currentTarget.value as PermissionMode })}
    >
      <option value="default">Use OpenCode's defaults</option>
      <option value="shell">Ask before running shell commands</option>
      <option value="all">Ask before everything</option>
    </select>
    <p class="hint">Takes effect in a new session, so changing it starts a fresh conversation per project.</p>
  </section>

  <section>
    <h2>Projects</h2>
    <ul>
      {#each settings.s.projects as dir (dir)}
        <li>
          <label>
            <input
              type="radio"
              name="project"
              checked={dir === settings.s.directory}
              onchange={() => settings.update({ directory: dir })}
            />
            <b>{basename(dir)}</b> <span class="path">{dir}</span>
          </label>
          {#if settings.s.projects.length > 1}
            <button onclick={() => settings.removeProject(dir)}>Remove</button>
          {/if}
        </li>
      {/each}
    </ul>
    <button onclick={addFolder}>Add folder…</button>
  </section>

  <section>
    <h2>General</h2>
    <label class="check">
      <input type="checkbox" checked={settings.s.muted} onchange={(e) => settings.update({ muted: e.currentTarget.checked })} />
      Mute Clippy's sounds
    </label>
    <label class="check stack">
      Menu bar &amp; Dock icon
      <select value={iconStatus.style} onchange={(e) => setIconStyle(e.currentTarget.value)}>
        <option value="paperclip">Paperclip</option>
        <option value="clippy" disabled={!iconStatus.clippy_available}>Clippy</option>
      </select>
      {#if !iconStatus.clippy_available}
        <span class="hint">The Clippy icon becomes available after installing the classic characters.</span>
      {/if}
    </label>
    <label class="check stack">
      Terminal app for "continue in terminal"
      <input
        list="terminals"
        placeholder="System default (Terminal unless you changed it)"
        value={settings.s.terminalApp}
        onchange={(e) => settings.update({ terminalApp: e.currentTarget.value.trim() })}
      />
      <datalist id="terminals">
        <option value="Terminal"></option>
        <option value="iTerm"></option>
        <option value="Ghostty"></option>
        <option value="WezTerm"></option>
        <option value="Warp"></option>
      </datalist>
    </label>
    <label class="check">
      <input type="checkbox" checked={autostart} onchange={(e) => toggleAutostart(e.currentTarget.checked)} />
      Launch at login
    </label>
    <label class="check">
      Show "result is ready" for replies longer than
      <input
        type="number"
        min="40"
        max="2000"
        step="10"
        value={settings.s.longReplyChars}
        onchange={(e) => settings.update({ longReplyChars: Number(e.currentTarget.value) || 220 })}
      />
      characters
    </label>
  </section>
</div>

<style>
  :global(html),
  :global(body) {
    margin: 0;
    background: #fff;
    color: #1f2328;
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :global(html),
    :global(body) {
      background: #1e1e1e;
      color: #e6e6e6;
    }
  }
  .page {
    padding: 8px 24px 32px;
    max-width: 560px;
    margin: 0 auto;
  }
  h1 {
    font-size: 20px;
  }
  h2 {
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.6;
    margin: 22px 0 6px;
  }
  .chars {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
  }
  .char {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 8px 4px;
    font: inherit;
    font-size: 12px;
    color: inherit;
    background: #8881;
    border: 2px solid transparent;
    border-radius: 8px;
    cursor: pointer;
  }
  .char.selected {
    border-color: #0969da;
    background: #0969da22;
  }
  .thumb {
    position: relative;
  }
  .classics {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-top: 12px;
  }
  .classics .hint {
    margin: 0;
  }
  progress {
    width: 100%;
    margin-top: 8px;
  }
  .layer {
    position: absolute;
    inset: 0;
    background-repeat: no-repeat;
  }
  select {
    width: 100%;
    padding: 4px;
  }
  .hint {
    font-size: 12px;
    opacity: 0.6;
    margin: 4px 0 0;
  }
  .err {
    color: #c33;
    font-size: 12px;
  }
  ul {
    list-style: none;
    padding: 0;
    margin: 0 0 8px;
  }
  li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 3px 0;
  }
  .path {
    opacity: 0.55;
    font-size: 12px;
    margin-left: 4px;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 6px 0;
  }
  .check.stack {
    flex-direction: column;
    align-items: stretch;
    gap: 4px;
  }
  input:not([type]) {
    padding: 4px;
  }
  input[type="number"] {
    width: 70px;
  }
</style>
