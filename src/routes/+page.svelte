<script lang="ts">
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { open } from "@tauri-apps/plugin-dialog";
  import Clippy from "$lib/clippy/Clippy.svelte";
  import { OpenCodeStore } from "$lib/opencode/store.svelte";
  import { basename, initSettings, settings } from "$lib/settings.svelte";

  const store = new OpenCodeStore();

  let bubbleEl = $state<HTMLElement>();
  let clippyEl = $state<HTMLElement>();
  let anim = $state("");
  let draft = $state("");
  let terminalAvailable = $state(true);
  let terminalProbe = 0;
  type Picker = "project" | "session" | "agent" | null;
  let picker = $state<Picker>(null);

  const perm = $derived(store.pending[0]);

  const feedSignal = $derived(store.bubble.feed?.map((i) => i.text.length + (i.state ?? "")).join(",") ?? "");
  const toolIcon = { run: "⚙", ok: "✓", fail: "✗" } as const;

  /** Keep the newest streamed text in view. */
  function stick(node: HTMLElement, _text: string) {
    node.scrollTop = node.scrollHeight;
    return {
      update() {
        node.scrollTop = node.scrollHeight;
      },
    };
  }
  const agentLabel = $derived(store.agents.find((a) => a.id === store.currentAgent)?.name ?? (store.currentAgent || "default"));
  const handoverTitle = $derived(
    !terminalAvailable
      ? settings.s.terminalApp.trim()
        ? `Terminal executable not found. Check Settings → General → Terminal app (${settings.s.terminalApp.trim()}).`
        : "Install xdg-terminal-exec or set a terminal executable in Settings → General → Terminal app."
      : store.canHandover
        ? "Continue this session in the terminal"
        : "Available between prompts, once a session exists",
  );

  $effect(() => {
    const terminal = settings.s.terminalApp.trim() || null;
    const probe = ++terminalProbe;
    invoke<boolean>("terminal_available_cmd", { terminal })
      .then((available) => {
        if (probe === terminalProbe) terminalAvailable = available;
      })
      .catch(() => {
        if (probe === terminalProbe) terminalAvailable = false;
      });
  });

  function toggle(which: Exclude<Picker, null>) {
    picker = picker === which ? null : which;
    if (picker === "session") store.loadSessions();
    if (picker === "agent") store.loadAgents();
  }

  function ago(ms: number) {
    const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
    if (m < 1) return "now";
    if (m < 60) return `${m}m`;
    if (m < 60 * 24) return `${Math.round(m / 60)}h`;
    return `${Math.round(m / 1440)}d`;
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape" && store.busy) return store.interrupt();
    if ((e.target as HTMLElement).closest("input, textarea")) return;
    if (e.key === "m") settings.update({ muted: !settings.s.muted });
  }

  function submit(e: Event) {
    e.preventDefault();
    const text = draft;
    draft = "";
    store.send(text);
  }

  async function addFolder() {
    const dir = await open({ directory: true, multiple: false, defaultPath: settings.s.directory });
    if (typeof dir === "string") {
      store.setProject(dir);
      picker = null;
    }
  }

  function pick(dir: string) {
    store.setProject(dir);
    picker = null;
  }

  function startDrag(e: MouseEvent) {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button, input, textarea, a")) return;
    getCurrentWindow().startDragging();
  }

  let fitted = 0;
  function fitWindow() {
    if (!bubbleEl || !clippyEl) return;
    const h = Math.ceil(bubbleEl.offsetHeight + clippyEl.offsetHeight + 8);
    if (h === fitted) return;
    fitted = h;
    invoke("fit_window", { height: h });
  }

  function reportHitRegions() {
    fitWindow();
    const rects = [bubbleEl, clippyEl].filter(Boolean).map((el) => {
      const r = el!.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    });
    invoke("set_hit_regions", { rects });
  }

  onMount(() => {
    initSettings().then(() => store.start());
    const ro = new ResizeObserver(reportHitRegions);
    if (bubbleEl) ro.observe(bubbleEl);
    if (clippyEl) ro.observe(clippyEl);
    window.addEventListener("resize", reportHitRegions);
    reportHitRegions();
    return () => {
      store.dispose();
      ro.disconnect();
      window.removeEventListener("resize", reportHitRegions);
    };
  });
</script>

<svelte:window onkeydown={onKey} />

<main>
  <div class="bubble" bind:this={bubbleEl} onmousedown={startDrag} role="presentation">
    <div class="topbar">
      <button class="chip" title="Switch project" onclick={() => toggle("project")}>
        📁 {basename(settings.s.directory)} ▾
      </button>
      <span class="spacer"></span>
      <span class="terminal-control" title={handoverTitle}>
        <button
          class="icon"
          title={handoverTitle}
          disabled={!store.canHandover || !terminalAvailable}
          onclick={() => store.handover()}>⌨</button
        >
      </span>
      <button class="icon" title="New session" onclick={() => store.newSession()}>↻</button>
      <button class="icon" title="Settings" onclick={() => invoke("open_settings")}>⚙</button>
    </div>
    <div class="topbar">
      <button class="chip half" title="Switch session" onclick={() => toggle("session")}>💬 {store.currentTitle} ▾</button>
      <button class="chip half" title="Choose agent" onclick={() => toggle("agent")}>🤖 {agentLabel} ▾</button>
    </div>

    {#if picker === "project"}
      <div class="list">
        {#each settings.s.projects as dir (dir)}
          <div class="row">
            <button class="pick" class:current={dir === settings.s.directory} title={dir} onclick={() => pick(dir)}>
              {basename(dir)}
            </button>
            {#if settings.s.projects.length > 1}
              <button class="icon" title="Remove from list" onclick={() => settings.removeProject(dir)}>×</button>
            {/if}
          </div>
        {/each}
        <button onclick={addFolder}>Add folder…</button>
      </div>
    {:else if picker === "session"}
      <div class="list">
        <button onclick={() => { store.newSession(); picker = null; }}>＋ New session</button>
        {#each store.sessionList as s (s.id)}
          <button
            class="pick"
            class:current={s.id === store.currentSessionId}
            title={s.title}
            onclick={() => { store.switchSession(s); picker = null; }}
          >
            {s.title} <small>{s.agent ?? ""} · {ago(s.updated)}</small>
          </button>
        {:else}
          <small>No earlier sessions in this project.</small>
        {/each}
      </div>
    {:else if picker === "agent"}
      <div class="list">
        {#each store.agents as a (a.id)}
          <button
            class="pick"
            class:current={a.id === store.currentAgent}
            title={a.description}
            onclick={() => { store.setAgent(a.id); picker = null; }}
          >
            {a.name} <small>{a.description}</small>
          </button>
        {:else}
          <small>No agents found.</small>
        {/each}
      </div>
    {:else if perm}
      <div class="text">
        In <b>{store.projectOf(perm.sessionID) || "a project"}</b>, may I run <b>{perm.action}</b>?<br />
        <code>{perm.resources.join(", ")}</code>
      </div>
      <div class="buttons">
        <button onclick={() => store.answer(perm, "once")}>Allow</button>
        <button onclick={() => store.answer(perm, "always")}>Always</button>
        <button onclick={() => store.answer(perm, "reject")}>Deny</button>
      </div>
    {:else}
      {#if store.bubble.kind === "stream"}
        <div class="titlebar">
          <div class="title">{store.bubble.title}</div>
          <button class="icon" title="Show detailed activity" onclick={() => store.openHistory()}>^</button>
        </div>
        <div class="feed" use:stick={feedSignal}>
          {#each store.bubble.feed ?? [] as item}
            {#if item.kind === "tool"}
              <div class="tool {item.state}">{toolIcon[item.state ?? "run"]} {item.text}</div>
            {:else if item.text.trim()}
              <p>{item.text.trim()}</p>
            {/if}
          {/each}
        </div>
        {#if store.bubble.status}
          <div class="status">{store.bubble.status}</div>
        {/if}
      {:else}
        <div class="text" class:error={store.bubble.kind === "error"}>{store.bubble.text}</div>
      {/if}
      {#if store.bubble.kind === "ready"}
        <div class="buttons">
          <button onclick={() => invoke("open_inspect")}>Inspect</button>
          <button onclick={() => store.openHistory()}>History</button>
        </div>
      {:else if store.bubble.kind === "text" && store.currentSessionId}
        <div class="buttons">
          <button onclick={() => store.openHistory()}>History</button>
        </div>
      {/if}
      {#if store.busy}
        <div class="buttons">
          <button onclick={() => store.interrupt()}>Stop (Esc)</button>
        </div>
      {:else if store.status === "ready"}
        <form onsubmit={submit}>
          <input bind:value={draft} placeholder="Ask me anything…" autocomplete="off" spellcheck="false" />
        </form>
      {/if}
    {/if}
    <div class="footer">
      <span class="debug">
        {store.mood} · {anim}{store.connected ? "" : " · offline"}{settings.s.muted ? " · muted" : ""}
      </span>
      <span class="model" title="{settings.s.model.providerID}/{settings.s.model.id}">{settings.s.model.id}</span>
    </div>
  </div>
  <Clippy mood={store.mood} character={settings.s.character} revision={settings.s.characterRevision} muted={settings.s.muted} bind:anim bind:el={clippyEl} onmousedown={startDrag} />
</main>

<style>
  :global(html),
  :global(body) {
    margin: 0;
    background: transparent;
    overflow: hidden;
    user-select: none;
    -webkit-user-select: none;
  }
  main {
    height: 100vh;
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
    align-items: center;
    gap: 8px;
  }
  .bubble {
    background: #ffffe1;
    border: 1px solid #000;
    border-radius: 8px;
    padding: 8px 12px 10px;
    font: 13px/1.3 Tahoma, Verdana, sans-serif;
    width: 236px;
    flex-shrink: 0;
    box-sizing: border-box;
  }
  .topbar {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-bottom: 6px;
  }
  .spacer {
    flex: 1;
  }
  .chip {
    font: 11px Tahoma, Verdana, sans-serif;
    max-width: 150px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chip.half {
    flex: 1;
    max-width: 50%;
  }
  small {
    font-size: 10px;
    opacity: 0.65;
  }
  .icon {
    font: 12px Tahoma, Verdana, sans-serif;
    padding: 0 6px;
  }
  .terminal-control {
    display: inline-flex;
  }
  .titlebar {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-bottom: 4px;
  }
  .title {
    flex: 1;
    font-weight: bold;
  }
  .feed {
    max-height: 96px;
    overflow-y: auto;
    word-break: break-word;
  }
  .feed p {
    margin: 0 0 6px;
    white-space: pre-wrap;
  }
  .tool {
    font: 11px ui-monospace, Menlo, monospace;
    color: #555;
    margin: 0 0 3px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tool.ok {
    color: #2a7a2a;
  }
  .tool.fail {
    color: #a00;
  }
  .status {
    margin-top: 4px;
    font-size: 11px;
    font-style: italic;
    color: #666;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .text {
    max-height: 120px;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .text.error {
    color: #a00;
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 140px;
    overflow-y: auto;
  }
  .row {
    display: flex;
    gap: 4px;
  }
  .list > :global(*) {
    flex: none;
  }
  .row .pick {
    flex: 1;
  }
  .pick {
    min-width: 0;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pick.current {
    font-weight: bold;
  }
  code {
    font-size: 11px;
    word-break: break-all;
  }
  .buttons {
    display: flex;
    gap: 6px;
    margin-top: 8px;
  }
  button {
    font: 12px Tahoma, Verdana, sans-serif;
  }
  .buttons button {
    flex: 1;
  }
  input {
    width: 100%;
    box-sizing: border-box;
    margin-top: 8px;
    font: 12px Tahoma, Verdana, sans-serif;
    user-select: text;
    -webkit-user-select: text;
  }
  .footer {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    margin-top: 6px;
    font-size: 10px;
    color: #777;
  }
  .debug {
    white-space: nowrap;
  }
  .model {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: right;
  }
</style>
