//! The menu bar and Dock icons. They default to the built-in paperclip; once the classic characters are
//! installed, the user can switch to a Clippy icon that is generated from the installed sprites.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Manager};

const PAPERCLIP_DOCK: &[u8] = include_bytes!("../icons/icon.png");
const PAPERCLIP_TRAY: &[u8] = include_bytes!("../icons/tray.png");

pub const CLIPPY_DOCK: &str = "clippy-dock.png";
pub const CLIPPY_TRAY: &str = "clippy-tray.png";

/// The tray icon, kept so its image can be swapped later.
pub struct TrayHandle(pub Mutex<Option<tauri::tray::TrayIcon>>);

pub fn icons_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("icons"))
}

fn clippy_icons(app: &AppHandle) -> Option<(Vec<u8>, Vec<u8>)> {
    let dir = icons_dir(app)?;
    Some((std::fs::read(dir.join(CLIPPY_DOCK)).ok()?, std::fs::read(dir.join(CLIPPY_TRAY)).ok()?))
}

fn current_style(app: &AppHandle) -> String {
    crate::prefs::get(app, "icon_style")
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_else(|| "paperclip".into())
}

#[cfg(target_os = "macos")]
fn set_dock_icon(png: &[u8]) {
    use objc2::AnyThread;
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::{MainThreadMarker, NSData};

    let Some(mtm) = MainThreadMarker::new() else { return };
    let data = NSData::with_bytes(png);
    if let Some(image) = NSImage::initWithData(NSImage::alloc(), &data) {
        unsafe { NSApplication::sharedApplication(mtm).setApplicationIconImage(Some(&image)) };
    }
}

/// Apply the saved icon style to the tray and the Dock. Falls back to the paperclip if the
/// Clippy icons are not available.
pub fn apply(app: &AppHandle) {
    let clippy = if current_style(app) == "clippy" { clippy_icons(app) } else { None };
    let (dock, tray, template) = match clippy {
        Some((dock, tray)) => (dock, tray, false),
        None => (PAPERCLIP_DOCK.to_vec(), PAPERCLIP_TRAY.to_vec(), true),
    };

    if let Some(handle) = app.try_state::<TrayHandle>() {
        if let Some(icon) = handle.0.lock().unwrap().as_ref() {
            if let Ok(image) = tauri::image::Image::from_bytes(&tray) {
                let _ = icon.set_icon(Some(image));
                let _ = icon.set_icon_as_template(template);
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        let _ = app.run_on_main_thread(move || set_dock_icon(&dock));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = dock;
}

/// Go back to the paperclip (used when the classic characters are removed).
pub fn reset(app: &AppHandle) {
    crate::prefs::set(app, "icon_style", json!("paperclip"));
    if let Some(dir) = icons_dir(app) {
        let _ = std::fs::remove_file(dir.join(CLIPPY_DOCK));
        let _ = std::fs::remove_file(dir.join(CLIPPY_TRAY));
    }
    apply(app);
}

#[derive(Serialize)]
pub struct IconStatus {
    style: String,
    clippy_available: bool,
}

fn status(app: &AppHandle) -> IconStatus {
    let available = clippy_icons(app).is_some();
    let style = current_style(app);
    IconStatus { style: if style == "clippy" && !available { "paperclip".into() } else { style }, clippy_available: available }
}

#[tauri::command]
pub fn icon_status(app: AppHandle) -> IconStatus {
    status(&app)
}

#[tauri::command]
pub fn set_icon_style(app: AppHandle, style: String) -> Result<IconStatus, String> {
    match style.as_str() {
        "paperclip" => {}
        "clippy" if clippy_icons(&app).is_some() => {}
        "clippy" => return Err("install the classic characters first".into()),
        _ => return Err("unknown icon style".into()),
    }
    crate::prefs::set(&app, "icon_style", json!(style));
    apply(&app);
    Ok(status(&app))
}
