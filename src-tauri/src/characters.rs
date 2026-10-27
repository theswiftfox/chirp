//! Characters live in `<app data>/characters/<id>/{agent.json, map.png, sounds/*.mp3, meta.json}`.
//! The "classic" Office characters are Microsoft's artwork, so they are never shipped with the app:
//! `install_clippy_bundle` downloads the community `clippyjs` package (pinned and integrity-checked)
//! and converts it into that layout on the user's machine.

use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine as _;
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha512};
use tauri::{AppHandle, Emitter, Manager};

const PACKAGE: &str = "clippyjs@0.1.0";
const PACKAGE_URL: &str = "https://registry.npmjs.org/clippyjs/-/clippyjs-0.1.0.tgz";
const INTEGRITY: &str = "sha512-XnchzSR8H8X43TvwnAktK5xDewKGSyfGu8DagBZCbOUdx0dWAFrFdxdCWlaJkyfx4M3Amvvu13jbHQ/IYQOD+w==";

const NAMES: &[(&str, &str)] = &[
    ("bonzi", "Bonzi (purple gorilla)"),
    ("clippy", "Clippy (paperclip)"),
    ("f1", "F1 (robot)"),
    ("genie", "Genie"),
    ("genius", "Genius (Einstein)"),
    ("links", "Links (cat)"),
    ("merlin", "Merlin (wizard)"),
    ("peedy", "Peedy (parrot)"),
    ("rocky", "Rocky (dog)"),
    ("rover", "Rover (dog)"),
];

#[derive(Serialize, Clone)]
struct Progress {
    stage: &'static str,
    progress: f32,
    message: String,
}

fn characters_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("characters"))
}

fn valid_segment(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s != "."
        && s != ".."
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
}

/// Metadata of every installed character.
#[tauri::command]
pub async fn list_characters(app: AppHandle) -> Result<Vec<Value>, String> {
    let dir = characters_dir(&app)?;
    let mut out: Vec<Value> = Vec::new();
    let Ok(entries) = fs::read_dir(&dir) else {
        return Ok(out);
    };
    for e in entries.flatten() {
        if e.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        if let Ok(text) = fs::read_to_string(e.path().join("meta.json"))
            && let Ok(v) = serde_json::from_str::<Value>(&text) {
                out.push(v);
            }
    }
    out.sort_by_key(|v| v["name"].as_str().unwrap_or("").to_string());
    Ok(out)
}

/// Raw bytes of one file of an installed character (`agent.json`, `map.png`, `sounds/3.mp3`, ...).
#[tauri::command]
pub async fn character_file(
    app: AppHandle,
    id: String,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    if !valid_segment(&id) {
        return Err("invalid character id".into());
    }
    let mut file = characters_dir(&app)?.join(&id);
    for seg in path.split('/') {
        if !valid_segment(seg) {
            return Err("invalid path".into());
        }
        file.push(seg);
    }
    let bytes = fs::read(&file).map_err(|e| format!("{}: {e}", file.display()))?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn install_clippy_bundle(app: AppHandle) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dest = characters_dir(&app)?;
        let emit = |stage: &'static str, progress: f32, message: String| {
            let _ = app.emit(
                "bundle-progress",
                Progress {
                    stage,
                    progress,
                    message,
                },
            );
        };
        emit("download", 0.0, format!("Downloading {PACKAGE}…"));
        let bytes = download(&|p| emit("download", p, format!("Downloading {PACKAGE}…")))?;
        let ids = install_from_bytes(&bytes, &dest, &|p, m| emit("install", p, m))?;
        if ids.iter().any(|id| id == "clippy") {
            // Optional extra: a Clippy tray/Dock icon the user can switch to in Settings.
            let made = crate::appicon::icons_dir(&app)
                .ok_or_else(|| "no app data folder".to_string())
                .and_then(|out| make_clippy_icons(&dest.join("clippy"), &out));
            if let Err(e) = made {
                eprintln!("could not generate the Clippy icons: {e}");
            }
        }
        emit("done", 1.0, format!("Installed {} characters", ids.len()));
        Ok(ids)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Remove every installed character (the built-in default is not stored here).
#[tauri::command]
pub async fn remove_installed_characters(app: AppHandle) -> Result<(), String> {
    let dir = characters_dir(&app)?;
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    crate::appicon::reset(&app);
    Ok(())
}

/// Cut Clippy's rest pose out of the installed sprite sheet and save it as a Dock icon (512 px,
/// with margin) and a menu bar icon (64 px) in `out_dir`.
pub fn make_clippy_icons(char_dir: &Path, out_dir: &Path) -> Result<(), String> {
    use image::{RgbaImage, imageops};

    let agent: Value =
        serde_json::from_slice(&fs::read(char_dir.join("agent.json")).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let num = |v: &Value, d: u32| v.as_u64().map(|n| n as u32).unwrap_or(d);
    let (w, h) = (
        num(&agent["framesize"][0], 124),
        num(&agent["framesize"][1], 93),
    );
    let rest = &agent["animations"]["RestPose"]["frames"][0]["images"][0];
    let (x, y) = (num(&rest[0], 0), num(&rest[1], 0));

    let sheet = image::open(char_dir.join("map.png"))
        .map_err(|e| e.to_string())?
        .to_rgba8();
    let frame = imageops::crop_imm(&sheet, x, y, w, h).to_image();

    let (mut min_x, mut min_y, mut max_x, mut max_y) = (w, h, 0, 0);
    for (px, py, p) in frame.enumerate_pixels() {
        if p[3] > 0 {
            min_x = min_x.min(px);
            min_y = min_y.min(py);
            max_x = max_x.max(px);
            max_y = max_y.max(py);
        }
    }
    if max_x < min_x || max_y < min_y {
        return Err("the rest pose is empty".into());
    }
    let mut still =
        imageops::crop_imm(&frame, min_x, min_y, max_x - min_x + 1, max_y - min_y + 1).to_image();
    // Resize with premultiplied alpha: the sprite's transparent pixels carry a colour key (magenta) that
    // would otherwise bleed into the edges as a halo.
    for p in still.pixels_mut() {
        let a = p[3] as u32;
        for c in 0..3 {
            p[c] = ((p[c] as u32 * a + 127) / 255) as u8;
        }
    }

    let fit = |canvas: u32, content: u32| -> RgbaImage {
        let scale = content as f32 / still.width().max(still.height()) as f32;
        let (nw, nh) = (
            ((still.width() as f32 * scale).round() as u32).max(1),
            ((still.height() as f32 * scale).round() as u32).max(1),
        );
        let mut resized = imageops::resize(&still, nw, nh, imageops::FilterType::Lanczos3);
        for p in resized.pixels_mut() {
            let a = p[3] as u32;
            for c in 0..3 {
                if let Some(value) = (p[c] as u32 * 255 + a / 2).checked_div(a) {
                    p[c] = value.min(255) as u8;
                }
            }
        }
        let mut out = RgbaImage::new(canvas, canvas);
        imageops::overlay(
            &mut out,
            &resized,
            ((canvas - nw) / 2) as i64,
            ((canvas - nh) / 2) as i64,
        );
        out
    };

    fs::create_dir_all(out_dir).map_err(|e| e.to_string())?;
    fit(512, 420)
        .save(out_dir.join(crate::appicon::CLIPPY_DOCK))
        .map_err(|e| e.to_string())?;
    fit(64, 64)
        .save(out_dir.join(crate::appicon::CLIPPY_TRAY))
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn download(progress: &dyn Fn(f32)) -> Result<Vec<u8>, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|e| e.to_string())?;
    let mut resp = client
        .get(PACKAGE_URL)
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("download failed: {e}"))?;
    let total = resp.content_length().unwrap_or(0) as f32;
    let mut buf = Vec::with_capacity(total as usize);
    let mut chunk = [0u8; 64 * 1024];
    let mut last = 0.0;
    loop {
        let n = resp
            .read(&mut chunk)
            .map_err(|e| format!("download failed: {e}"))?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        if total > 0.0 {
            let p = buf.len() as f32 / total;
            if p - last >= 0.02 {
                last = p;
                progress(p);
            }
        }
    }
    Ok(buf)
}

fn verify_integrity(bytes: &[u8]) -> Result<(), String> {
    let digest = Sha512::digest(bytes);
    let got = format!(
        "sha512-{}",
        base64::engine::general_purpose::STANDARD.encode(digest)
    );
    if got == INTEGRITY {
        Ok(())
    } else {
        Err(format!(
            "integrity check failed for {PACKAGE}: refusing to use it"
        ))
    }
}

/// Verify the tarball, convert every character in it and write them below `dest`.
pub fn install_from_bytes(
    bytes: &[u8],
    dest: &Path,
    progress: &dyn Fn(f32, String),
) -> Result<Vec<String>, String> {
    verify_integrity(bytes)?;
    progress(0.0, "Reading package…".into());

    let mut files: HashMap<(String, String), Vec<u8>> = HashMap::new();
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(bytes));
    for entry in archive.entries().map_err(|e| e.to_string())? {
        let mut entry = entry.map_err(|e| e.to_string())?;
        let path = entry
            .path()
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .to_string();
        let parts: Vec<&str> = path.split('/').collect();
        if parts.len() == 5
            && parts[..3] == ["package", "dist", "agents"]
            && matches!(parts[4], "agent.mjs" | "map.mjs" | "sounds-mp3.mjs")
        {
            let mut buf = Vec::new();
            entry.read_to_end(&mut buf).map_err(|e| e.to_string())?;
            files.insert((parts[3].to_string(), parts[4].to_string()), buf);
        }
    }

    let ids: BTreeSet<String> = files.keys().map(|(id, _)| id.clone()).collect();
    fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let mut installed = Vec::new();
    for (i, id) in ids.iter().enumerate() {
        progress(i as f32 / ids.len() as f32, format!("Installing {id}…"));
        if !valid_segment(id) {
            continue;
        }
        let get = |f: &str| files.get(&(id.clone(), f.to_string()));
        let (Some(agent), Some(map), Some(sounds)) =
            (get("agent.mjs"), get("map.mjs"), get("sounds-mp3.mjs"))
        else {
            continue;
        };
        write_character(dest, id, agent, map, sounds)?;
        installed.push(id.clone());
    }
    if installed.is_empty() {
        return Err("the package did not contain any characters".into());
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    fs::write(
        dest.join(".bundle.json"),
        json!({ "package": PACKAGE, "integrity": INTEGRITY, "ids": installed, "installed_at": now }).to_string(),
    )
    .map_err(|e| e.to_string())?;
    Ok(installed)
}

fn write_character(
    dest: &Path,
    id: &str,
    agent_js: &[u8],
    map_js: &[u8],
    sounds_js: &[u8],
) -> Result<(), String> {
    let png = data_uri_bytes(&String::from_utf8_lossy(map_js))
        .ok_or_else(|| format!("{id}: no sprite sheet in map.mjs"))?;
    if png.len() < 24 || &png[1..4] != b"PNG" {
        return Err(format!("{id}: sprite sheet is not a PNG"));
    }
    let sheet = [
        u32::from_be_bytes([png[16], png[17], png[18], png[19]]),
        u32::from_be_bytes([png[20], png[21], png[22], png[23]]),
    ];

    let mut agent =
        parse_agent(&String::from_utf8_lossy(agent_js)).map_err(|e| format!("{id}: {e}"))?;
    let framesize = agent["framesize"].clone();
    let rest = agent["animations"]["RestPose"]["frames"][0]["images"].clone();
    agent["sheet"] = json!(sheet);

    let name = NAMES
        .iter()
        .find(|(k, _)| *k == id)
        .map(|(_, v)| *v)
        .unwrap_or(id);
    let meta = json!({
        "id": id,
        "name": name,
        "framesize": framesize,
        "sheet": sheet,
        "rest": if rest.is_array() { rest } else { json!([[0, 0]]) },
    });

    let tmp = dest.join(format!(".{id}.tmp"));
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(tmp.join("sounds")).map_err(|e| e.to_string())?;
    fs::write(tmp.join("map.png"), &png).map_err(|e| e.to_string())?;
    fs::write(tmp.join("agent.json"), agent.to_string()).map_err(|e| e.to_string())?;
    fs::write(tmp.join("meta.json"), meta.to_string()).map_err(|e| e.to_string())?;
    for (key, bytes) in parse_sounds(&String::from_utf8_lossy(sounds_js)) {
        if valid_segment(&key) {
            fs::write(tmp.join("sounds").join(format!("{key}.mp3")), bytes)
                .map_err(|e| e.to_string())?;
        }
    }
    let target = dest.join(id);
    let _ = fs::remove_dir_all(&target);
    fs::rename(&tmp, &target).map_err(|e| e.to_string())
}

/// `var x = {...};\nexport { x as default };` -> the object literal as JSON.
fn parse_agent(src: &str) -> Result<Value, String> {
    // Stop before the trailing `export { x as default };`, whose braces would otherwise match.
    let body = &src[..src.rfind("export").unwrap_or(src.len())];
    let (a, b) = (body.find('{'), body.rfind('}'));
    match (a, b) {
        (Some(a), Some(b)) if a < b => {
            let mut v =
                json5::from_str::<Value>(&body[a..=b]).map_err(|e| format!("agent.mjs: {e}"))?;
            normalize_numbers(&mut v);
            Ok(v)
        }
        _ => Err("agent.mjs: no object literal".into()),
    }
}

/// json5 reads every number as a float; turn whole numbers back into integers (`100.0` -> `100`).
fn normalize_numbers(v: &mut Value) {
    match v {
        Value::Number(n) => {
            if let Some(f) = n.as_f64()
                && n.is_f64() && f.fract() == 0.0 && f.abs() < 9.0e15 {
                    *v = json!(f as i64);
                }
        }
        Value::Array(a) => a.iter_mut().for_each(normalize_numbers),
        Value::Object(o) => o.values_mut().for_each(normalize_numbers),
        _ => {}
    }
}

/// The first `"data:<mime>;base64,<payload>"` string literal in `src`.
fn data_uri_bytes(src: &str) -> Option<Vec<u8>> {
    let start = src.find("base64,")? + "base64,".len();
    let end = start + src[start..].find('"')?;
    base64::engine::general_purpose::STANDARD
        .decode(&src[start..end])
        .ok()
}

/// `{ 1: "data:audio/mpeg;base64,...", 2: ... }` (one entry per line) -> [(key, mp3 bytes)].
fn parse_sounds(src: &str) -> Vec<(String, Vec<u8>)> {
    src.lines()
        .filter_map(|line| {
            let (key, rest) = line.split_once(": \"data:audio/mpeg;base64,")?;
            let payload = rest.trim_end().trim_end_matches(',').trim_end_matches('"');
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(payload)
                .ok()?;
            Some((key.trim().trim_matches('"').to_string(), bytes))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs against a real tarball: `CLIPPY_TGZ=/path/to/clippyjs-0.1.0.tgz cargo test`.
    #[test]
    fn installs_every_character_from_the_real_package() {
        let Ok(path) = std::env::var("CLIPPY_TGZ") else {
            eprintln!("CLIPPY_TGZ not set, skipping");
            return;
        };
        let bytes = fs::read(path).unwrap();
        let dest = std::env::temp_dir().join(format!("chirp-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dest);

        let ids = install_from_bytes(&bytes, &dest, &|_, _| {}).unwrap();
        assert_eq!(ids.len(), 10, "{ids:?}");
        for id in &ids {
            let agent: Value =
                serde_json::from_slice(&fs::read(dest.join(id).join("agent.json")).unwrap())
                    .unwrap();
            assert!(
                agent["animations"]["RestPose"].is_object(),
                "{id}: no RestPose"
            );
            assert!(agent["framesize"][0].as_u64().unwrap() > 0);
            assert!(agent["sheet"][0].as_u64().unwrap() > 0);
            let meta: Value =
                serde_json::from_slice(&fs::read(dest.join(id).join("meta.json")).unwrap())
                    .unwrap();
            assert_eq!(meta["id"], *id);
            let declared = agent["sounds"].as_array().map(|a| a.len()).unwrap_or(0);
            let written = fs::read_dir(dest.join(id).join("sounds")).unwrap().count();
            assert_eq!(declared, written, "{id}: sounds declared vs written");
        }
        // Icons derived from the installed Clippy.
        let icons = dest.join("icons-out");
        make_clippy_icons(&dest.join("clippy"), &icons).unwrap();
        for (file, size) in [
            (crate::appicon::CLIPPY_DOCK, 512),
            (crate::appicon::CLIPPY_TRAY, 64),
        ] {
            let img = image::open(icons.join(file)).unwrap().to_rgba8();
            assert_eq!((img.width(), img.height()), (size, size), "{file}");
            assert!(img.pixels().any(|p| p[3] > 200), "{file} is blank");
            assert_eq!(
                img.get_pixel(0, 0)[3],
                0,
                "{file}: the corner should be transparent"
            );
        }
        if let Ok(preview) = std::env::var("CLIPPY_ICON_PREVIEW") {
            let _ = fs::create_dir_all(&preview);
            for file in [crate::appicon::CLIPPY_DOCK, crate::appicon::CLIPPY_TRAY] {
                let _ = fs::copy(icons.join(file), Path::new(&preview).join(file));
            }
        }
        let rocky: Value =
            serde_json::from_slice(&fs::read(dest.join("rocky/agent.json")).unwrap()).unwrap();
        assert!(rocky["animations"]["Idle(1)"].is_object());
        let _ = fs::remove_dir_all(&dest);
    }

    #[test]
    fn rejects_a_tampered_package() {
        let err = install_from_bytes(
            b"not the real package",
            &std::env::temp_dir().join("chirp-x"),
            &|_, _| {},
        )
        .unwrap_err();
        assert!(err.contains("integrity"), "{err}");
    }

    #[test]
    fn path_segments_are_validated() {
        assert!(valid_segment("clippy") && valid_segment("agent.json") && valid_segment("3.mp3"));
        assert!(
            !valid_segment("..")
                && !valid_segment("a/b")
                && !valid_segment("")
                && !valid_segment("x y")
        );
    }
}
