export interface Frame {
  duration: number;
  images?: number[][];
  sound?: string;
  exitBranch?: number;
  branching?: { branches: { frameIndex: number; weight: number }[] };
}

export interface AgentData {
  framesize: [number, number];
  overlayCount?: number;
  sheet: [number, number];
  animations: Record<string, { frames: Frame[] }>;
}

/** Sprite-sheet offsets of the layers to draw, bottom first; null draws nothing. */
export type Sprite = number[][] | null;

export class ClippyPlayer {
  private token = 0;
  private exiting = false;
  private wake: (() => void) | null = null;
  private finish: (() => void) | null = null;
  private sounds = new Map<string, HTMLAudioElement>();

  muted = false;
  current = "";

  constructor(
    private data: AgentData,
    private onFrame: (sprite: Sprite) => void,
    private soundUrl: (id: string) => string | undefined = () => undefined,
  ) {}

  has(name: string) {
    return name in this.data.animations;
  }

  names() {
    return Object.keys(this.data.animations);
  }

  /**
   * Ask the running animation (or wait) to wrap up at its next exit point.
   * If it hasn't finished after graceMs, it is cut off.
   */
  exit(graceMs = 350) {
    this.exiting = true;
    this.wake?.();
    const token = this.token;
    setTimeout(() => {
      if (token === this.token) this.cut();
    }, graceMs);
  }

  private cut() {
    this.token++;
    this.finish?.();
  }

  /** Sleep that ends early when exit() is called. */
  wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      const self = this;
      function done() {
        clearTimeout(t);
        self.wake = null;
        resolve();
      }
      this.wake = done;
    });
  }

  rest() {
    this.onFrame(this.data.animations.RestPose?.frames[0]?.images ?? [[0, 0]]);
  }

  /** Plays once; resolves when the last frame has been shown or the animation was exited. */
  play(name: string): Promise<void> {
    const anim = this.data.animations[name];
    if (!anim) return Promise.resolve();
    const token = ++this.token;
    this.exiting = false;
    this.current = name;
    const frames = anim.frames;

    return new Promise((resolve) => {
      this.finish = resolve;
      const step = (i: number) => {
        if (token !== this.token) return resolve();
        const f = frames[i];
        this.onFrame(f.images?.length ? f.images : null);
        if (f.sound) this.playSound(f.sound);
        setTimeout(() => {
          const next = this.next(frames, i);
          if (next === null) return resolve();
          step(next);
        }, f.duration);
      };
      step(0);
    });
  }

  private next(frames: Frame[], i: number): number | null {
    const f = frames[i];
    if (this.exiting && f.exitBranch !== undefined) return f.exitBranch;
    if (f.branching) {
      let rnd = Math.random() * 100;
      for (const b of f.branching.branches) {
        if (rnd <= b.weight) return b.frameIndex;
        rnd -= b.weight;
      }
    }
    return i + 1 < frames.length ? i + 1 : null;
  }

  private playSound(id: string) {
    if (this.muted) return;
    let a = this.sounds.get(id);
    if (!a) {
      const url = this.soundUrl(id);
      if (!url) return;
      a = new Audio(url);
      a.volume = 0.4;
      this.sounds.set(id, a);
    }
    a.currentTime = 0;
    a.play().catch(() => {});
  }
}
