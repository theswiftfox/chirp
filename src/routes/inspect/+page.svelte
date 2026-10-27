<script lang="ts">
  import { onMount } from "svelte";
  import { marked } from "marked";
  import DOMPurify from "dompurify";
  import { invoke } from "@tauri-apps/api/core";
  import { HISTORY_KEY, REPLY_KEY } from "$lib/opencode/store.svelte";

  interface Reply {
    prompt: string;
    project?: string;
    text: string;
    time: number;
    sessionID?: string;
    title?: string;
  }

  let reply = $state<Reply | null>(null);
  let copied = $state(false);

  const html = $derived(reply ? DOMPurify.sanitize(marked.parse(reply.text, { gfm: true, async: false }) as string) : "");

  function load() {
    const raw = localStorage.getItem(REPLY_KEY);
    reply = raw ? (JSON.parse(raw) as Reply) : null;
  }

  async function copy() {
    if (!reply) return;
    await navigator.clipboard.writeText(reply.text);
    copied = true;
    setTimeout(() => (copied = false), 1200);
  }

  async function history() {
    if (!reply?.sessionID) return;
    localStorage.setItem(
      HISTORY_KEY,
      JSON.stringify({ sessionID: reply.sessionID, title: reply.title ?? "Conversation", project: reply.project ?? "" }),
    );
    await invoke("open_history");
  }

  onMount(() => {
    load();
    const onStorage = (e: StorageEvent) => e.key === REPLY_KEY && load();
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  });
</script>

<svelte:head><title>Chirp</title></svelte:head>

<div class="page">
  {#if reply}
    <header>
      <div class="prompt">{#if reply.project}<span class="project">{reply.project}</span>{/if}{reply.prompt}</div>
      {#if reply.sessionID}<button onclick={history}>Full conversation</button>{/if}
      <button onclick={copy}>{copied ? "Copied!" : "Copy"}</button>
    </header>
    <article>{@html html}</article>
  {:else}
    <p class="empty">No result yet.</p>
  {/if}
</div>

<style>
  :global(html),
  :global(body) {
    margin: 0;
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
    padding: 16px 24px 40px;
    max-width: 860px;
    margin: 0 auto;
  }
  header {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    border-bottom: 1px solid #8884;
    padding-bottom: 10px;
    margin-bottom: 8px;
  }
  .prompt {
    flex: 1;
    font-weight: 600;
    opacity: 0.8;
  }
  .project {
    font-weight: 400;
    font-size: 12px;
    background: #8882;
    border-radius: 4px;
    padding: 1px 6px;
    margin-right: 8px;
  }
  .empty {
    opacity: 0.6;
  }
  article :global(pre) {
    background: #8881;
    padding: 10px 12px;
    border-radius: 6px;
    overflow-x: auto;
  }
  article :global(code) {
    font: 12.5px ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  article :global(:not(pre) > code) {
    background: #8882;
    padding: 1px 5px;
    border-radius: 4px;
  }
  article :global(table) {
    border-collapse: collapse;
  }
  article :global(th),
  article :global(td) {
    border: 1px solid #8886;
    padding: 4px 8px;
  }
  article :global(a) {
    color: #0969da;
  }
</style>
