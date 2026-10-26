<script lang="ts">
  import { ClippyPlayer, type Sprite } from "./player";
  import { Behavior, type Mood } from "./behavior";
  import { loadCharacter, type LoadedCharacter } from "./characters";

  interface Props {
    mood: Mood;
    character?: string;
    /** Changes when characters are installed or removed. */
    revision?: number;
    muted?: boolean;
    el?: HTMLElement;
    anim?: string;
    onmousedown?: (e: MouseEvent) => void;
  }

  let { mood, character = "default", revision = 0, muted = false, el = $bindable(), anim = $bindable(""), onmousedown }: Props = $props();

  // Characters range from 80x80 to 200x160: scale each to fit the same box.
  const MAX_W = 150;
  const MAX_H = 140;

  let size = $state<[number, number]>([124, 93]);
  let sheet = $state<[number, number]>([1, 1]);
  let overlays = $state(1);
  let images = $state<Sprite>(null);
  let sheetUrl = $state("");
  let failed = $state(false);
  let player: ClippyPlayer | undefined;
  let behavior: Behavior | undefined;

  const scale = $derived(Math.min(MAX_W / size[0], MAX_H / size[1]));

  $effect(() => {
    const id = character;
    void revision;
    let cancelled = false;
    failed = false;
    let mine: Behavior | undefined;
    let loaded: LoadedCharacter | undefined;

    loadCharacter(id)
      .then((ch) => {
        if (cancelled) return ch.dispose();
        loaded = ch;
        const data = ch.data;
        size = data.framesize;
        sheet = data.sheet;
        overlays = data.overlayCount ?? 1;
        images = data.animations.RestPose?.frames[0]?.images ?? [[0, 0]];
        sheetUrl = ch.sheetUrl;
        const p = new ClippyPlayer(
          data,
          (im) => {
            images = im;
            anim = p.current;
          },
          ch.soundUrl,
        );
        p.muted = muted;
        player = p;
        mine = behavior = new Behavior(p);
        mine.setMood(mood);
      })
      .catch((err) => {
        console.warn("could not load character", id, err);
        if (!cancelled) failed = true;
      });

    return () => {
      cancelled = true;
      mine?.dispose();
      loaded?.dispose();
      if (behavior === mine) behavior = undefined;
    };
  });

  // Read the props first: with `behavior?.setMood(mood)` the optional chain
  // short-circuits while behavior is undefined and the effect tracks nothing.
  $effect(() => {
    const m = mood;
    behavior?.setMood(m);
  });
  $effect(() => {
    const mu = muted;
    if (player) player.muted = mu;
  });
</script>

<div
  bind:this={el}
  class="sprite"
  style:width="{size[0] * scale}px"
  style:height="{size[1] * scale}px"
  {onmousedown}
  role="presentation"
>
  {#if failed}
    <div class="fallback" title="Could not load the character">📎</div>
  {/if}
  {#each { length: overlays } as _, i}
    <div
      class="layer"
      style:display={images && i < images.length ? "block" : "none"}
      style:background-image={sheetUrl ? `url(${sheetUrl})` : "none"}
      style:background-size="{sheet[0] * scale}px {sheet[1] * scale}px"
      style:background-position={images?.[i] ? `-${images[i][0] * scale}px -${images[i][1] * scale}px` : "0 0"}
    ></div>
  {/each}
</div>

<style>
  .sprite {
    position: relative;
    cursor: grab;
  }
  .fallback {
    font-size: 64px;
    line-height: 1;
    text-align: center;
    padding-top: 12px;
  }
  .layer {
    position: absolute;
    inset: 0;
    background-repeat: no-repeat;
  }
</style>
