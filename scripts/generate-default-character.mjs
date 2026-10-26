#!/usr/bin/env node
// Generates the built-in placeholder character (static/characters/default/) and the app icons from it.
// Everything here is original artwork, so the output is committed to the repository.
//
//   node scripts/generate-default-character.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "static", "characters", "default");
const ICONS = join(ROOT, "src-tauri", "icons");
const CELL_W = 128;
const CELL_H = 144;

/** A plain paperclip, drawn as a wire. */
const CLIP_PATH = "M38 64 L38 30 A13 13 0 0 1 64 30 L64 70 A20 20 0 0 1 24 70 L24 38";
const clipSvg = ({ size = 100, color = "#000", stroke = 7 } = {}) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 88 100">
    <path d="${CLIP_PATH}" transform="translate(6 0)" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;

/** Dock icon: the paperclip on a soft rounded tile, in the usual macOS proportions. */
const appIconSvg = () => `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fbfcff"/><stop offset="1" stop-color="#dde2ef"/></linearGradient>
    <linearGradient id="wire" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8da2dc"/><stop offset="1" stop-color="#3f508a"/></linearGradient>
    <filter id="soft" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="14" stdDeviation="14" flood-color="#1d2a55" flood-opacity="0.28"/></filter>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#tile)" filter="url(#soft)"/>
  <g transform="translate(512 512) rotate(18) scale(6.6) translate(-44 -50)">
    <path d="${CLIP_PATH}" transform="translate(6 0)" fill="none" stroke="url(#wire)" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
</svg>`;

const BLUE = "#3f8fd8";
const BLUE_LIGHT = "#74b9f3";
const BLUE_DARK = "#245f9f";
const CREAM = "#fdf1d6";
const CREAM_SHADE = "#ecd6a8";
const BEAK = "#f4a63c";
const BEAK_DARK = "#c97a1c";
const FEET = "#e58a2b";
const BLUSH = "#f58ca0";
const MOUTH = "#47200f";
const BROW = "#14100e";

const BROWS = {
  neutral: { l: [0, -4], r: [0, 4] },
  up: { l: [-5, -6], r: [-5, 6] },
  sad: { l: [1, -20], r: [1, 20] },
  focus: { l: [2, 14], r: [2, -14] },
  think: { l: [-6, -10], r: [3, -12] },
  wow: { l: [-8, -4], r: [-8, 4] },
};

/** How far the lower beak drops for each mouth state. */
const BEAK_OPEN = { closed: 0, sad: 0, open: 4.5, o: 6, wide: 9 };

/** One frame of the songbird as an SVG. */
function frameSvg({
  dy = 0, sx = 1, sy = 1, px = 0, py = 0, pupil = 5.4,
  eyes = "open", brows = "neutral", mouth = "open", tail = 0, arms = "down", ears = 0,
}) {
  const EYE = [[50, 52], [78, 52]];
  const R = 10.5;

  const eyeSvg = ([cx, cy]) => {
    if (eyes === "closed") {
      return `<ellipse cx="${cx}" cy="${cy}" rx="${R}" ry="${R - 0.5}" fill="url(#plume)"/>
        <path d="M${cx - 8} ${cy + 1} Q${cx} ${cy + 8} ${cx + 8} ${cy + 1}" stroke="${BROW}" stroke-width="2.6" fill="none" stroke-linecap="round"/>`;
    }
    return `<circle cx="${cx}" cy="${cy}" r="${R}" fill="url(#eyeWhite)"/>
      <circle cx="${cx + px}" cy="${cy + py}" r="${pupil}" fill="#0c0a0a"/>
      <circle cx="${cx + px + pupil * 0.38}" cy="${cy + py - pupil * 0.4}" r="${pupil * 0.3}" fill="#fff"/>`;
  };

  const browSvg = ([cx, cy], [by, rot]) =>
    `<path d="M-9 3 Q0 -4 9 2" transform="translate(${cx} ${cy - 16 + by}) rotate(${rot})" stroke="${BROW}" stroke-width="4.4" fill="none" stroke-linecap="round"/>`;

  const drop = BEAK_OPEN[mouth];
  const beak = `${
    drop > 0
      ? `<path d="M55.5 66.5 Q64 ${67 + drop * 1.6} 72.5 66.5 Z" fill="${MOUTH}"/>`
      : ""
  }<path d="M56 66.5 Q64 ${67.5 + drop} 72 66.5 Q64 ${69.5 + drop * 1.15} 56 66.5 Z" fill="${BEAK_DARK}"/>
    <path d="M52.5 64.5 Q64 53 75.5 64.5 Q64 69.4 52.5 64.5 Z" fill="${BEAK}"/>
    <path d="M58 60.6 Q62 58.6 66 59.4" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round" opacity="0.5"/>
    ${mouth === "sad" ? `<path d="M56 71 Q64 67.5 72 71" stroke="${MOUTH}" stroke-width="2" fill="none" stroke-linecap="round" opacity="0.6"/>` : ""}`;

  const wing = (ux, uy, rot, flip) =>
    `<ellipse cx="${ux}" cy="${uy}" rx="10" ry="22" transform="rotate(${rot} ${ux} ${uy})" fill="url(#wing)"/>
     <path d="M${ux - 3 * flip} ${uy + 6} q${-1 * flip} 8 ${-4 * flip} 12 M${ux + 2 * flip} ${uy + 7} q${-0.5 * flip} 7 ${-2 * flip} 11" transform="rotate(${rot} ${ux} ${uy})" stroke="${BLUE_DARK}" stroke-width="1.3" fill="none" stroke-linecap="round" opacity="0.55"/>`;
  const wings =
    arms === "up" ? wing(22, 74, -38, 1) + wing(106, 74, 38, -1) : wing(31, 92, 12, 1) + wing(97, 92, -12, -1);

  const foot = (x) =>
    `<path d="M${x} 120 V137" stroke="${FEET}" stroke-width="3.4" stroke-linecap="round"/>
     <path d="M${x - 8} 139.5 L${x} 137 L${x + 8} 139.5 M${x} 137 V141" stroke="${FEET}" stroke-width="2.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;

  const crest = `
    <g transform="rotate(${ears - 14} 64 30)"><path d="M64 32 C57 22 54 12 58 5 C66 12 68 22 64 32 Z" fill="url(#plume)"/></g>
    <g transform="rotate(${ears} 64 30)"><path d="M62 32 C57 19 58 8 64 1 C71 9 70 22 66 32 Z" fill="url(#plume)"/></g>
    <g transform="rotate(${ears + 14} 64 30)"><path d="M64 32 C61 22 63 12 70 6 C74 14 71 24 64 32 Z" fill="url(#plume)"/></g>`;

  const [bl, br] = [BROWS[brows].l, BROWS[brows].r];

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CELL_W}" height="${CELL_H}" viewBox="0 0 ${CELL_W} ${CELL_H}">
    <defs>
      <linearGradient id="plume" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${BLUE_LIGHT}"/><stop offset="0.55" stop-color="${BLUE}"/><stop offset="1" stop-color="#2d6fb4"/></linearGradient>
      <linearGradient id="wing" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${BLUE}"/><stop offset="1" stop-color="${BLUE_DARK}"/></linearGradient>
      <radialGradient id="eyeWhite" cx="0.4" cy="0.35" r="0.75"><stop offset="0" stop-color="#ffffff"/><stop offset="0.8" stop-color="#f3f3f6"/><stop offset="1" stop-color="#d4d5de"/></radialGradient>
      <linearGradient id="cream" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${CREAM_SHADE}"/><stop offset="0.4" stop-color="${CREAM}"/><stop offset="1" stop-color="${CREAM_SHADE}"/></linearGradient>
    </defs>
    <ellipse cx="64" cy="142" rx="${34 + (1 - sy) * 40}" ry="3.6" fill="#0000001c"/>
    <g transform="translate(0 ${dy}) translate(64 141) scale(${sx * 0.95} ${sy * 0.95}) translate(-64 -141)">
      <g transform="rotate(${tail} 64 112)">
        <path d="M58 108 C46 118 30 124 18 133 C32 136 48 132 62 124 Z" fill="${BLUE_DARK}"/>
        <path d="M60 104 C50 108 34 108 22 112 C34 120 50 120 64 116 Z" fill="url(#wing)"/>
        <path d="M62 112 C56 122 46 130 40 138 C54 138 66 130 70 122 Z" fill="${BLUE}"/>
      </g>
      ${foot(52)}${foot(76)}
      <ellipse cx="64" cy="88" rx="35" ry="36" fill="url(#plume)"/>
      <ellipse cx="64" cy="99" rx="22" ry="25" fill="url(#cream)"/>
      ${wings}
      ${crest}
      <ellipse cx="64" cy="56" rx="34" ry="29" fill="url(#plume)"/>
      <ellipse cx="64" cy="64" rx="24" ry="17" fill="url(#cream)" opacity="0.9"/>
      <circle cx="38" cy="66" r="5.5" fill="${BLUSH}" opacity="0.45"/>
      <circle cx="90" cy="66" r="5.5" fill="${BLUSH}" opacity="0.45"/>
      ${eyeSvg(EYE[0])}${eyeSvg(EYE[1])}
      ${browSvg([EYE[0][0], EYE[0][1]], bl)}${browSvg([EYE[1][0], EYE[1][1]], br)}
      ${beak}
    </g>
  </svg>`;
}

const FRAMES = [
  /* 0 */ {},
  /* 1 */ { eyes: "closed" },
  /* 2 */ { px: -4.5 },
  /* 3 */ { px: 4.5 },
  /* 4 */ { py: -4.5, brows: "up" },
  /* 5 */ { dy: -2, sx: 0.98, sy: 1.03, mouth: "wide", brows: "up", arms: "up" },
  /* 6 */ { sx: 1.05, sy: 0.92, mouth: "closed" },
  /* 7 */ { eyes: "open", brows: "sad", mouth: "sad", ears: 9, dy: 2, sy: 0.97, py: 2 },
  /* 8 */ { mouth: "wide", brows: "up" },
  /* 9 */ { py: 4.5 },
  /* 10 */ { tail: -6 },
  /* 11 */ { tail: 5 },
  /* 12 */ { brows: "think", px: -3.5, py: -4, mouth: "closed" },
  /* 13 */ { brows: "wow", pupil: 4.6, mouth: "o" },
  /* 14 */ { brows: "focus", py: 4, mouth: "closed" },
];
const REST = 0, BLINK = 1, LEFT = 2, RIGHT = 3, UP = 4, HOP = 5, SQUASH = 6, SAD = 7, HAPPY = 8, DOWN = 9,
  WAG_A = 10, WAG_B = 11, THINK = 12, WOW = 13, FOCUS = 14;

const f = (index, duration = 120) => ({ duration, images: [[index * CELL_W, 0]] });
const seq = (...items) => ({ frames: items.map((i) => (Array.isArray(i) ? f(...i) : f(i))) });
const repeat = (n, items) => Array.from({ length: n }, () => items).flat();

// The names follow the classic characters', so the mood mapping in behavior.ts finds them.
// The eyebrows carry most of the expression: thinking, focusing, surprise.
const animations = {
  RestPose: seq(REST),
  IdleTailWag: seq(WAG_A, WAG_B, WAG_A, WAG_B, WAG_A, [REST, 200]),
  Idle1_1: seq([REST, 1500], [BLINK, 140], [REST, 200], [BLINK, 140], [REST, 300]),
  LookLeft: seq([LEFT, 900], REST),
  LookRight: seq([RIGHT, 900], REST),
  LookUp: seq([UP, 900], REST),
  LookDown: seq([DOWN, 900], REST),
  Thinking: seq([THINK, 900], [UP, 450], [THINK, 900], [LEFT, 450], [THINK, 700], [BLINK, 140], [THINK, 700], [REST, 200]),
  Processing: seq(...repeat(3, [[FOCUS, 260], [BLINK, 120], [FOCUS, 260], [SQUASH, 140], [HOP, 140]]).flat(), [REST, 100]),
  Writing: seq(...repeat(4, [[FOCUS, 420], [DOWN, 220], [FOCUS, 420], [LEFT, 200], [FOCUS, 380], [RIGHT, 200]]).flat(), [REST, 100]),
  Searching: seq(...repeat(3, [[LEFT, 420], [UP, 260], [RIGHT, 420], [UP, 260]]).flat(), [REST, 100]),
  CheckingSomething: seq([THINK, 500], [LEFT, 400], [RIGHT, 400], [THINK, 500], [REST, 300]),
  GetAttention: seq(...repeat(3, [[WOW, 160], [HOP, 140]]).flat(), [WOW, 500], [REST, 100]),
  Alert: seq(...repeat(4, [[WOW, 130], [HOP, 110]]).flat(), [REST, 100]),
  Congratulate: seq(HOP, SQUASH, HOP, SQUASH, [HAPPY, 900], [REST, 100]),
  Greeting: seq([HAPPY, 700], HOP, SQUASH, [HAPPY, 500], [REST, 150]),
  Sad: seq([SAD, 1800], [REST, 200]),
  GoodBye: seq([HAPPY, 600], [BLINK, 150], [REST, 100]),
};

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const cells = await Promise.all(FRAMES.map((spec) => sharp(Buffer.from(frameSvg(spec))).png().toBuffer()));
  await sharp({ create: { width: CELL_W * FRAMES.length, height: CELL_H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(cells.map((input, i) => ({ input, left: i * CELL_W, top: 0 })))
    .png()
    .toFile(join(OUT, "map.png"));

  const sheet = [CELL_W * FRAMES.length, CELL_H];
  writeFileSync(join(OUT, "agent.json"), JSON.stringify({ overlayCount: 1, sounds: [], framesize: [CELL_W, CELL_H], animations, sheet }));
  writeFileSync(
    join(OUT, "meta.json"),
    JSON.stringify({ id: "default", name: "Songbird (default)", framesize: [CELL_W, CELL_H], sheet, rest: [[0, 0]] }),
  );

  // Icons: a plain paperclip. The menu bar icon is a template image (shape only, macOS tints it).
  mkdirSync(ICONS, { recursive: true });
  const clear = { r: 0, g: 0, b: 0, alpha: 0 };
  await sharp(Buffer.from(clipSvg({ size: 64, color: "#000", stroke: 9 }))).png().toFile(join(ICONS, "tray.png"));
  const source = join(ICONS, "source.png");
  await sharp(Buffer.from(appIconSvg())).png().toFile(source);
  execFileSync(join(ROOT, "node_modules", ".bin", "tauri"), ["icon", source], { cwd: ROOT, stdio: "ignore" });
  for (const mobile of ["android", "ios"]) rmSync(join(ICONS, mobile), { recursive: true, force: true });

  console.log(`default character: ${FRAMES.length} frames, ${Object.keys(animations).length} animations`);
}

main();
