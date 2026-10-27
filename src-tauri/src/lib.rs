mod appicon;
mod characters;
mod prefs;
mod server;

use std::sync::Mutex;
use std::time::Duration;

use serde::Deserialize;
use tauri::{Manager, State};

#[derive(Deserialize, Clone, Copy)]
struct Rect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

#[derive(Default)]
struct HitRegions(Mutex<Vec<Rect>>);

#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "Tauri injects command state by value."
)]
fn set_hit_regions(rects: Vec<Rect>, state: State<HitRegions>) {
    *state.0.lock().unwrap() = rects;
}

/// Shrink or grow the main window to its content so no transparent area is left above the bubble.
/// The bottom edge stays put where the platform lets us move windows (not on Wayland).
#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "Tauri injects the app handle by value."
)]
#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "The UI-derived physical size is clamped to the u32 range before conversion."
)]
fn fit_window(app: tauri::AppHandle, height: f64) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    let (Ok(scale), Ok(size), Ok(pos)) =
        (win.scale_factor(), win.outer_size(), win.outer_position())
    else {
        return;
    };
    let new_h = (height * scale)
        .round()
        .clamp(1.0, f64::from(u32::MAX)) as u32;
    if new_h == size.height {
        return;
    }
    let _ = win.set_size(tauri::PhysicalSize::new(size.width, new_h));
    let _ = win.set_position(tauri::PhysicalPosition::new(
        pos.x,
        pos.y + size.height.cast_signed() - new_h.cast_signed(),
    ));
}

fn open_window(
    app: &tauri::AppHandle,
    label: &str,
    title: &str,
    w: f64,
    h: f64,
) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::App(label.into()))
        .title(title)
        .inner_size(w, h)
        .min_inner_size(360.0, 300.0)
        .build()
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "linux")]
    appicon::set_window_icons(app);
    Ok(())
}

#[tauri::command]
async fn open_inspect(app: tauri::AppHandle) -> Result<(), String> {
    open_window(&app, "inspect", "Chirp", 640.0, 720.0)
}

#[tauri::command]
async fn open_history(app: tauri::AppHandle) -> Result<(), String> {
    open_window(&app, "history", "Chirp Activity", 560.0, 680.0)
}

#[tauri::command]
async fn open_settings(app: tauri::AppHandle) -> Result<(), String> {
    open_window(&app, "settings", "Chirp Settings", 520.0, 640.0)
}

fn load_always_on_top(app: &tauri::AppHandle) -> bool {
    prefs::get(app, "always_on_top")
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

fn save_always_on_top(app: &tauri::AppHandle, value: bool) {
    prefs::set(app, "always_on_top", serde_json::json!(value));
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{CheckMenuItem, Menu, MenuItem};
    use tauri::tray::TrayIconBuilder;

    let toggle = MenuItem::with_id(app, "toggle", "Show / hide Clippy", true, None::<&str>)?;
    let on_top_pref = load_always_on_top(app.handle());
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_always_on_top(on_top_pref);
    }
    let on_top = CheckMenuItem::with_id(
        app,
        "on_top",
        "Stay on top",
        true,
        on_top_pref,
        None::<&str>,
    )?;
    let on_top_item = on_top.clone();
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Chirp", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&toggle, &on_top, &settings, &quit])?;

    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;
    let tray = TrayIconBuilder::new()
        .icon(icon)
        .icon_as_template(true)
        .menu(&menu)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "toggle" => {
                if let Some(w) = app.get_webview_window("main") {
                    if w.is_visible().unwrap_or(true) {
                        let _ = w.hide();
                    } else {
                        let _ = w.show();
                    }
                }
            }
            "on_top" => {
                let on = on_top_item.is_checked().unwrap_or(true);
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.set_always_on_top(on);
                }
                save_always_on_top(app, on);
            }
            "settings" => {
                let _ = open_window(app, "settings", "Chirp Settings", 520.0, 640.0);
            }
            "quit" => app.exit(0),
            _ => {}
        });
    let tray_icon = tray.build(app)?;
    app.manage(appicon::TrayHandle(Mutex::new(Some(tray_icon))));
    Ok(())
}

fn spawn_click_through_watcher(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut ignoring: Option<bool> = None;
        loop {
            std::thread::sleep(Duration::from_millis(30));
            let Some(win) = app.get_webview_window("main") else {
                continue;
            };
            let (Ok(cursor), Ok(origin), Ok(scale)) = (
                win.cursor_position(),
                win.outer_position(),
                win.scale_factor(),
            ) else {
                continue;
            };
            let cx = (cursor.x - f64::from(origin.x)) / scale;
            let cy = (cursor.y - f64::from(origin.y)) / scale;
            let inside = app
                .state::<HitRegions>()
                .0
                .lock()
                .unwrap()
                .iter()
                .any(|r| cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h);
            let want_ignore = !inside;
            if ignoring != Some(want_ignore)
                && win.set_ignore_cursor_events(want_ignore).is_ok() {
                    ignoring = Some(want_ignore);
                }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Starts the Tauri application.
///
/// # Panics
/// Panics if Tauri cannot build the application configuration.
pub fn run() {
    tauri::Builder::default()
        // Must come first: a second launch hands over to the running copy and exits.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(HitRegions::default())
        .manage(server::ServerState::default())
        .invoke_handler(tauri::generate_handler![
            set_hit_regions,
            fit_window,
            open_inspect,
            open_history,
            open_settings,
            server::start_server,
            server::open_in_terminal_cmd,
            server::terminal_available_cmd,
            characters::list_characters,
            characters::character_file,
            characters::install_clippy_bundle,
            characters::remove_installed_characters,
            appicon::icon_status,
            appicon::set_icon_style
        ])
        .setup(|app| {
            spawn_click_through_watcher(app.handle().clone());
            build_tray(app)?;
            appicon::apply(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<server::ServerState>().shutdown();
            }
        });
}
