import type { ClippyPlayer } from "./player";

export type Mood =
  | "idle"
  | "greet"
  | "thinking"
  | "working"
  | "writing"
  | "searching"
  | "checking"
  | "alert"
  | "done"
  | "error"
  | "goodbye";

// Each character names its animations a little differently ("Thinking" / "Think",
// "Greeting" / "Greet", ...), so every mood lists candidates and the first one that exists wins.
const LOOPING: Partial<Record<Mood, string[]>> = {
  thinking: ["Thinking", "Think", "Processing", "Process"],
  working: ["Processing", "Process", "CheckingSomething", "Thinking", "Think"],
  writing: ["Writing", "Write", "Reading", "Read"],
  searching: ["Searching", "Search", "ImageSearching"],
  checking: ["CheckingSomething", "Reading", "Read", "Thinking", "Think"],
};

const ONE_SHOT: Partial<Record<Mood, string[]>> = {
  greet: ["Greeting", "Greet", "Wave", "Acknowledge"],
  done: ["Congratulate", "Congratulate_2", "CharacterSucceeds", "Pleased", "Acknowledge"],
  error: ["Sad", "Confused", "Uncertain", "DontRecognize", "Embarrassed", "Surprised", "LookDown"],
  goodbye: ["GoodBye", "Goodbye", "Wave", "Hide"],
};

const ALERT_INTRO = ["GetAttention", "GetAttentionMinor", "Surprised"];
const ALERT_LOOP = ["Alert", "GetAttention", "GetAttentionMinor", "Surprised"];

const IDLE_RE = /^(Idle|Look|Blink|Gesture)/;
const SEQUEL_RE = /(Return|Continued)$/;
const RARE_RE = /snooze|sleep|DeepIdle|ToGround|AgainstWall/i;

const MIN_HOLD_MS = 1500;

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

export class Behavior {
  private gen = 0;
  private current?: Mood;
  private since = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private chain: Promise<void> = Promise.resolve();
  private idles: string[];
  private rareIdles: string[];

  constructor(private player: ClippyPlayer) {
    const names = player.names().filter((n) => IDLE_RE.test(n) && !SEQUEL_RE.test(n));
    this.rareIdles = names.filter((n) => RARE_RE.test(n));
    this.idles = names.filter((n) => !RARE_RE.test(n));
  }

  setMood(mood: Mood) {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    // Rapid flips between activity moods (thinking <-> writing <-> tools) look jittery,
    // so hold the current animation for a minimum time and only apply the latest request.
    if (this.current && mood in LOOPING && this.current in LOOPING && mood !== this.current) {
      const wait = MIN_HOLD_MS - (Date.now() - this.since);
      if (wait > 0) {
        this.timer = setTimeout(() => {
          this.timer = undefined;
          this.apply(mood);
        }, wait);
        return;
      }
    }
    this.apply(mood);
  }

  private apply(mood: Mood) {
    if (mood === this.current) return;
    this.current = mood;
    this.since = Date.now();
    const gen = ++this.gen;
    this.player.exit();
    this.chain = this.chain.then(() => this.run(mood, gen));
  }

  /** Stop all activity for good (component unmount / hot reload / character change). */
  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.gen++;
    this.player.exit(0);
  }

  private live(gen: number) {
    return gen === this.gen;
  }

  private first(candidates: string[] | undefined) {
    return candidates?.find((n) => this.player.has(n));
  }

  /** Play an animation, then its "...Return" companion if the character has one. */
  private async playWithReturn(name: string, gen: number) {
    await this.player.play(name);
    const ret = `${name}Return`;
    if (this.live(gen) && this.player.has(ret)) await this.player.play(ret);
  }

  private async run(mood: Mood, gen: number) {
    if (!this.live(gen)) return;
    const p = this.player;

    const loop = this.first(LOOPING[mood]);
    if (loop) {
      while (this.live(gen)) await p.play(loop);
      return;
    }

    if (mood === "alert") {
      const intro = this.first(ALERT_INTRO);
      const again = this.first(ALERT_LOOP);
      while (this.live(gen)) {
        if (intro) await p.play(intro);
        if (!this.live(gen)) return;
        if (again) await p.play(again);
        p.rest();
        await p.wait(rand(2500, 5000));
      }
      return;
    }

    const once = this.first(ONE_SHOT[mood]);
    if (once) await p.play(once);
    if (mood === "goodbye") return;

    while (this.live(gen)) {
      p.rest();
      await p.wait(rand(5000, 12000));
      if (!this.live(gen)) return;
      const rare = this.rareIdles.length > 0 && Math.random() < 0.08;
      const pool = rare ? this.rareIdles : this.idles;
      if (pool.length) await this.playWithReturn(pick(pool), gen);
    }
  }
}
