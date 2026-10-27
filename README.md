# Chirp

A desktop companion for [OpenCode](https://opencode.ai) that looks like the Office Assistants of old.
A character floats on your desktop, tells you what the agent is doing in a speech bubble, asks for
permission when the agent needs it, and lets you prompt it by typing into the bubble.

> *"It looks like you're trying to refactor a module. Would you like help?"*

Built with [Tauri](https://tauri.app) v2 and SvelteKit (Svelte 5). Runs on **macOS** and **Linux**. Tested on macOS 27, Fedora 44 with GNOME on Wayland. Windows as well as other Linux distributions and desktops are untested.

## Features

- A transparent, draggable character that stays on top of your windows. Clicks pass through everywhere except the
  character and the speech bubble.
- The character reacts to what the agent does: thinking, writing, searching, running tools, waiting for
  permission, done, error.
- A live activity feed in the bubble (commentary and tool steps as they happen), a viewer for long replies, and
  Allow / Always / Deny buttons for permission requests.
- Several projects, each with its own remembered session. Switch between existing sessions and pick the agents
  defined in the selected project.
- Hand a session over to your terminal between prompts. The terminal attaches to the same server, so both stay in
  sync.
- Menu bar icon, a built-in songbird and an optional download of the classic Office characters.

## Requirements

| What | Version | Check |
| --- | --- | --- |
| macOS | 10.13 or newer (developed on a recent release) | |
| Xcode command line tools (macOS) | | `xcode-select -p` (install with `xcode-select --install`) |
| Linux | Tauri's [Linux prerequisites](https://v2.tauri.app/start/prerequisites/#linux) | |
| [Node.js](https://nodejs.org) | 20.19+ or 22.12+ | `node -v` |
| [Rust](https://rustup.rs) | 1.85+ (the crate uses edition 2024) | `rustc --version` |
| [OpenCode](https://opencode.ai) | v2, connected to a model provider | `opencode --version` |

Chirp starts and manages its own `opencode serve`, so OpenCode has to be installed and logged in to a provider
(for example with `opencode auth`) before you use it. It finds the `opencode` binary on your `PATH`, then through
your login shell; set `OPENCODE_BIN=/path/to/opencode` if it still can't.

## Install

There are no prebuilt downloads: you build the app once from source.

```sh
git clone https://github.com/theswiftfox/chirp.git
cd chirp
npm install
npm run tauri build -- --bundles app # on linux use --bundles rpm for example
```

The first build takes a few minutes (it compiles the Rust side in release mode). On macOS the app ends up at
`src-tauri/target/release/bundle/macos/Chirp.app`. Drag it to `/Applications` and open it:

```sh
cp -R src-tauri/target/release/bundle/macos/Chirp.app /Applications/
open /Applications/Chirp.app
```

Notes:

- macOS: the app is only ad-hoc signed, not notarized. An app you build yourself opens normally. If you copy it to another
  Mac or download it, macOS may refuse to open it: right-click it and choose **Open**, or run
  `xattr -dr com.apple.quarantine /Applications/Chirp.app`.
- To update, pull the repository and build again.
- Only one copy runs at a time: opening Chirp again just brings the running one to the front. That includes the
  development build, so quit the installed app before `npm run tauri dev`, or the dev run will only focus it.

## First run

1. Chirp starts its OpenCode server (a few seconds) and the songbird appears near the bottom right of your
   screen. Drag it anywhere. The menu bar icon controls it (show/hide, stay on top, settings, quit).
2. **Check the model.** The default model is `github-copilot/claude-haiku-5.5`, which you may not have. Open
   **⚙ Settings → Model** and pick one you can use. The default is set in `src/lib/config.ts`.
3. Type a request into the bubble and press Enter. The first project is your home directory; use the **📁** chip to
   add or switch to a real project folder.
4. With some providers the very first request of a fresh server can fail
   with a 401. Chirp retries it once automatically.

## Using it

| Control | What it does |
| --- | --- |
| **📁 project** | Switch project or add a folder. Every project keeps its own session. |
| **💬 session** | Continue an earlier session of this project, or start a new one. New sessions are titled after your first prompt. |
| **🤖 agent** | Choose an agent. The list comes from the selected project, so its own `.opencode/agent/` agents appear. |
| **⌨** | Open your terminal on this session (see below). Only available between prompts. |
| **↻** | Start a fresh session in this project. |
| **⚙** | Settings. |
| **Stop** or `Esc` | Interrupt the running prompt. |
| `m` | Mute or unmute the character's sounds (when the window has focus and you're not typing). |

While the agent works, the bubble shows a **"Let me think about that…"** title, then a live feed of its commentary and
tool steps (`⚙` while running, `✓` or `✗` when finished). When it's done you get the answer directly, or "The result
is ready!" with an **Inspect** button for long replies. Inspect opens a window with the rendered markdown. When the
agent needs permission, the character raises an alert and the bubble asks **Allow / Always / Deny**, naming the project
the request comes from.

### Continue in the terminal

The **⌨** button opens your terminal on the current session with the OpenCode TUI attached to Chirp's own server.
Because both use the same server, they stay in sync: if you keep working in the terminal, Clippy shows the activity
too, and you can answer permission requests from either side.

- macOS: it uses whichever app opens `.command` files (Terminal unless you changed it). Pick or type another one under
  **Settings → General → Terminal app** (for example iTerm, Ghostty, WezTerm or Warp).
- Linux: it uses `xdg-terminal-exec` to open your desktop's preferred terminal. If that utility is unavailable, set a
  terminal executable under **Settings → General → Terminal app**. The ⌨ button is disabled when neither is available.
- Windows isn't supported yet.
- Quitting Chirp stops the server, which disconnects a terminal attached to it.

## Settings

| Setting | Notes |
| --- | --- |
| Character | The built-in songbird, plus the classic characters once installed (below). |
| Model | Applies to the next prompt and keeps the current conversation. |
| Permissions | OpenCode's defaults, ask before shell commands, or ask before everything. Takes effect in a new session, so changing it starts a fresh conversation per project. |
| Projects | The folders you work in. |
| Mute | Silences the characters' sounds. |
| Menu bar & Dock icon | A paperclip, or Clippy once the classic characters are installed. |
| Terminal app | For the ⌨ button. |
| "Result is ready" length | Replies longer than this are shown as a result to inspect instead of in the bubble. |

## Characters

Chirp ships with one original character, a songbird. Everything in this repository, including the paperclip app
icon, is original artwork, generated by `scripts/generate-default-character.mjs`.

The classic Office characters (Clippy, Rocky, Links, Merlin, Genie, Bonzi, F1, Genius, Peedy, Rover) are Microsoft's
artwork, so they are **not included** and are an optional download: open **Settings → Character → Install classic
characters**. The app downloads the community [`clippyjs`](https://github.com/pi0/clippyjs) package from npm (pinned
to an exact version and checked against a known SHA-512), converts the characters on your computer and stores them in
the app data folder. This is the only network access Chirp makes on its own, besides whatever OpenCode itself does.
You can remove them again from the same place. After installing them you can also switch the Dock and menu bar icon to
Clippy under **Settings → General**.

These characters are Microsoft's property. Use them for personal purposes only and do not redistribute them or builds
that contain them.

## Where things are stored

| What | Where |
| --- | --- |
| Installed characters, generated icons, `prefs.json` (stay on top, icon style) | macOS: `~/Library/Application Support/com.theswiftfox.chirp/`. Linux: `~/.local/share/com.theswiftfox.chirp/` |
| Settings and remembered sessions | The app's web storage. macOS: `~/Library/WebKit/com.theswiftfox.chirp` for the installed app, `~/Library/WebKit/chirp` for `npm run tauri dev`. Linux: `localstorage/` inside the folder above |
| Your sessions and conversations | OpenCode's own storage, as usual. Chirp doesn't keep copies. |

On macOS the installed app and the development build keep **separate settings**, so a fresh install starts with defaults.

The OpenCode server Chirp starts only listens on `127.0.0.1`, on a random port, with a random password that is
generated for each launch.

## Troubleshooting

- **"Couldn't start OpenCode".** Make sure `opencode --version` works in a terminal. Apps launched from Finder don't
  get your shell's `PATH`; Chirp falls back to asking your login shell, but you can set `OPENCODE_BIN` explicitly.
- **Replies fail or the model is "not found".** Pick an available model in Settings → Model (see First run).
- **A permission request is waiting but I can't see it.** The character shows an alert and the bubble asks; if the
  settings or a picker is open, close it first.
- **The character is a 📎 placeholder.** Its files couldn't be loaded. Switch character in Settings, or reinstall the
  classic characters.
- **Start over.** Quit the app, then delete the two folders in the table above.

To uninstall, quit the app, delete `Chirp.app`, and delete the folders above.

### Linux notes

- For `npm run tauri dev`, run `npm run dev:desktop-entry` once so the dock shows the right icon (it installs a
  dev `.desktop` entry; pass `--remove` to undo it).

## Development

```sh
npm install
npm run tauri dev          # run with hot reload
npm run check              # type-check the frontend
cargo test                 # in src-tauri/, the Rust tests (see below)
npm run generate:default   # regenerate the built-in character and the app icons
```

The installer test needs the real package: download `clippyjs-0.1.0.tgz` (for example with
`npm pack clippyjs@0.1.0`) and run `CLIPPY_TGZ=/path/to/clippyjs-0.1.0.tgz cargo test` in `src-tauri/`. Without that
variable the test is skipped.

How it fits together:

- `src-tauri/src/server.rs` starts `opencode serve` on a free port with a random password, stops it on quit, and opens
  the terminal hand-over.
- `src-tauri/src/characters.rs` installs and serves optional characters from the app data folder.
- `src-tauri/src/appicon.rs` switches the Dock and menu bar icons; `prefs.rs` stores the settings the Rust side owns.
- `src/lib/opencode/` talks to the server's HTTP API and event stream and maps events to moods and bubble content.
- `src/lib/clippy/` plays Microsoft Agent style sprite-sheet animations (frames, branching, exit transitions, overlays).
- `src/routes/` has the main window, the settings window and the result viewer.
- `scripts/generate-default-character.mjs` draws the default songbird and the icons; its poses and colours are plain
  constants at the top.

## Licence

Apache License 2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE).
Not affiliated with or endorsed by Microsoft or Anomaly (OpenCode). "Clippy", "Office Assistant" and "Copilot" are
Microsoft trademarks.
