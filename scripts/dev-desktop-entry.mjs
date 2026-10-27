// Linux dev only: Wayland docks take the app icon from a .desktop file matched by app id ("chirp").
// Installed packages ship their own; this installs a hidden, icon-only entry for `tauri dev`.
// Usage: node scripts/dev-desktop-entry.mjs [--remove]
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const share = join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"));
const desktop = join(share, "applications/chirp-dev.desktop");
const icon = join(share, "icons/hicolor/128x128/apps/chirp.png");
const source = join(dirname(fileURLToPath(import.meta.url)), "../src-tauri/icons/128x128.png");

if (process.platform !== "linux") process.exit(0);

if (process.argv.includes("--remove")) {
  rmSync(desktop, { force: true });
  rmSync(icon, { force: true });
} else {
  mkdirSync(dirname(desktop), { recursive: true });
  mkdirSync(dirname(icon), { recursive: true });
  copyFileSync(source, icon);
  writeFileSync(
    desktop,
    `[Desktop Entry]
Type=Application
Name=Chirp (dev)
Exec=chirp
Icon=chirp
StartupWMClass=chirp
NoDisplay=true
`,
  );
}

spawnSync("update-desktop-database", [dirname(desktop)], { stdio: "ignore" });
spawnSync("gtk-update-icon-cache", ["-f", "-t", join(share, "icons/hicolor")], { stdio: "ignore" });
