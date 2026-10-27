<script lang="ts">
  import { onMount, tick } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { marked } from "marked";
  import DOMPurify from "dompurify";
  import { OpenCodeClient, type ConversationItem } from "$lib/opencode/client";
  import { HISTORY_KEY } from "$lib/opencode/store.svelte";

  interface Target {
    sessionID: string;
    title: string;
    project: string;
  }

  let target = $state<Target | null>(null);
  let items = $state<ConversationItem[]>([]);
  let older = $state<ConversationItem[]>([]);
  let cursor = "";
  let more = $state(false);
  let loadingMore = $state(false);
  let error = $state("");
  let live = $state(false);
  let scroller = $state<HTMLElement>();
  let follow = true;
  let client: OpenCodeClient | undefined;
  let stopEvents: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let liveTimer: ReturnType<typeof setTimeout> | undefined;

  const icon = { run: "⚙", ok: "✓", fail: "✗" } as const;

  const md = (t: string) => DOMPurify.sanitize(marked.parse(t, { gfm: true, async: false }) as string);

  async function refresh() {
    if (!client || !target) return;
    const id = target.sessionID;
    try {
      const page = await client.conversation(id);
      if (target?.sessionID !== id) return;
      items = page.items;
      if (!older.length) {
        cursor = page.cursor;
        more = page.more;
      }
      error = "";
      await tick();
      if (follow && scroller) scroller.scrollTop = scroller.scrollHeight;
    } catch (err) {
      error = String(err);
    }
  }

  async function loadEarlier() {
    if (!client || !target || loadingMore || !more) return;
    const id = target.sessionID;
    loadingMore = true;
    try {
      const page = await client.conversation(id, cursor);
      if (target?.sessionID !== id) return;
      const before = scroller?.scrollHeight ?? 0;
      older = [...page.items, ...older];
      cursor = page.cursor;
      more = page.more;
      error = "";
      await tick();
      if (scroller) scroller.scrollTop += scroller.scrollHeight - before;
    } catch (err) {
      error = String(err);
    } finally {
      loadingMore = false;
    }
  }

  function onScroll() {
    if (!scroller) return;
    follow = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
  }

  function loadTarget() {
    const raw = localStorage.getItem(HISTORY_KEY);
    const next = raw ? (JSON.parse(raw) as Target) : null;
    if (next?.sessionID !== target?.sessionID) {
      items = [];
      older = [];
      cursor = "";
      more = false;
      follow = true;
    }
    target = next;
    refresh();
  }

  function onEvent(e: { type: string; data?: any }) {
    if (!target || e.data?.sessionID !== target.sessionID || !e.type.startsWith("session.")) return;
    if (e.type === "session.execution.started") live = true;
    if (e.type === "session.execution.succeeded" || e.type === "session.execution.failed") live = false;
    clearTimeout(timer);
    timer = setTimeout(refresh, 250);
    // Covers a run that was already going when the window opened.
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => (live = false), 15000);
  }

  onMount(() => {
    const onStorage = (e: StorageEvent) => e.key === HISTORY_KEY && loadTarget();
    window.addEventListener("storage", onStorage);
    (async () => {
      try {
        const info = await invoke<{ url: string; password: string }>("start_server");
        client = new OpenCodeClient(info.url, info.password);
        stopEvents = client.subscribe(onEvent);
        loadTarget();
      } catch (err) {
        error = String(err);
      }
    })();
    return () => {
      window.removeEventListener("storage", onStorage);
      stopEvents?.();
      clearTimeout(timer);
      clearTimeout(liveTimer);
    };
  });
</script>

<svelte:head><title>Chirp Activity</title></svelte:head>

<div class="page">
  <header>
    <div class="head">
      {#if target?.project}<span class="project">{target.project}</span>{/if}
      <span class="title">{target?.title ?? "No conversation"}</span>
    </div>
    {#if live}<span class="live">● working</span>{/if}
  </header>

  <div class="scroll" bind:this={scroller} onscroll={onScroll}>
    {#if error}<p class="error">{error}</p>{/if}
    {#if more}
      <button class="earlier" disabled={loadingMore} onclick={loadEarlier}>
        {loadingMore ? "Loading…" : "Fetch earlier part of conversation"}
      </button>
    {/if}
    {#each [...older, ...items] as item}
      {#if item.kind === "user"}
        <div class="user">{item.text}</div>
      {:else if item.kind === "text"}
        <div class="reply">{@html md(item.text)}</div>
      {:else if item.kind === "thinking"}
        <div class="step">… thinking</div>
      {:else}
        <div class="step {item.state}">{icon[item.state ?? "run"]} {item.text}</div>
      {/if}
    {:else}
      {#if !error}<p class="empty">{target ? "Nothing here yet." : "Open a conversation from Chirp."}</p>{/if}
    {/each}
  </div>
</div>

<style>
  :global(html),
  :global(body) {
    margin: 0;
    height: 100%;
    background: #fff;
    color: #1f2328;
    font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :global(html),
    :global(body) {
      background: #1e1e1e;
      color: #e6e6e6;
    }
  }
  .page {
    height: 100vh;
    display: flex;
    flex-direction: column;
  }
  header {
    display: flex;
    gap: 12px;
    align-items: center;
    padding: 10px 20px;
    border-bottom: 1px solid #8884;
  }
  .head {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .title {
    font-weight: 600;
  }
  .project {
    font-size: 12px;
    background: #8882;
    border-radius: 4px;
    padding: 1px 6px;
    margin-right: 8px;
  }
  .live {
    font-size: 12px;
    color: #2a7a2a;
  }
  .scroll {
    flex: 1;
    overflow-y: auto;
    padding: 12px 20px 32px;
  }
  .earlier {
    display: block;
    margin: 0 auto 8px;
    font: inherit;
    font-size: 12px;
  }
  .user {
    margin: 14px 0 8px auto;
    max-width: 85%;
    width: fit-content;
    background: #0969da22;
    border-radius: 10px;
    padding: 6px 12px;
    white-space: pre-wrap;
  }
  .reply {
    margin: 6px 0;
  }
  .step {
    font: 12px ui-monospace, SFMono-Regular, Menlo, monospace;
    opacity: 0.75;
    margin: 2px 0 2px 8px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .step.ok {
    color: #2a7a2a;
  }
  .step.fail,
  .error {
    color: #c00;
  }
  .empty {
    opacity: 0.6;
  }
  .reply :global(pre) {
    background: #8881;
    padding: 10px 12px;
    border-radius: 6px;
    overflow-x: auto;
  }
  .reply :global(code) {
    font: 12.5px ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .reply :global(:not(pre) > code) {
    background: #8882;
    padding: 1px 5px;
    border-radius: 4px;
  }
  .reply :global(table) {
    border-collapse: collapse;
  }
  .reply :global(th),
  .reply :global(td) {
    border: 1px solid #8886;
    padding: 4px 8px;
  }
</style>
