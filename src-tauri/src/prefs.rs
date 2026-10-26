//! A tiny key/value store for settings that the Rust side owns (`<app data>/prefs.json`).

use std::path::PathBuf;

use serde_json::{Map, Value};
use tauri::{AppHandle, Manager};

fn path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("prefs.json"))
}

fn read(app: &AppHandle) -> Map<String, Value> {
    path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

pub fn get(app: &AppHandle, key: &str) -> Option<Value> {
    read(app).get(key).cloned()
}

pub fn set(app: &AppHandle, key: &str, value: Value) {
    let Some(path) = path(app) else { return };
    let mut prefs = read(app);
    prefs.insert(key.to_string(), value);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(path, Value::Object(prefs).to_string());
}
