use std::io::Read;
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager};

#[derive(Serialize, Clone)]
pub struct ServerInfo {
    pub url: String,
    pub password: String,
}

#[derive(Default)]
pub struct ServerState {
    child: Mutex<Option<Child>>,
    info: Mutex<Option<ServerInfo>>,
}

impl ServerState {
    pub fn shutdown(&self) {
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        *self.info.lock().unwrap() = None;
    }
}

/// Quote a string for safe use inside a POSIX shell script.
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Open the default terminal with the opencode TUI attached to our server, on the given session.
pub fn open_in_terminal(
    app: &AppHandle,
    directory: &str,
    session_id: &str,
    terminal: Option<&str>,
) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    if session_id.is_empty() || !session_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err("invalid session id".into());
    }
    if !std::path::Path::new(directory).is_dir() {
        return Err(format!("directory does not exist: {directory}"));
    }
    let info = app
        .state::<ServerState>()
        .info
        .lock()
        .unwrap()
        .clone()
        .ok_or("the OpenCode server is not running")?;
    let bin = resolve_opencode()?;
    let bin_dir = bin.parent().map(|p| p.to_path_buf()).unwrap_or_default();

    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // Scripts contain the server password: remove leftovers that never ran.
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            if e.file_name().to_string_lossy().starts_with("handover-") {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }

    let script = format!(
        "#!/bin/zsh -l\nrm -f -- \"$0\"\ncd {dir} || exit 1\nexport PATH={bin_dir}:\"$PATH\"\nexport OPENCODE_SERVER_PASSWORD={pw}\nexec {bin} --server {url} --session {sid}\n",
        dir = sh_quote(directory),
        bin_dir = sh_quote(&bin_dir.to_string_lossy()),
        pw = sh_quote(&info.password),
        bin = sh_quote(&bin.to_string_lossy()),
        url = sh_quote(&info.url),
        sid = sh_quote(session_id),
    );
    let path = dir.join(format!("handover-{session_id}.command"));
    std::fs::write(&path, script).map_err(|e| e.to_string())?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;

    let mut cmd = Command::new("open");
    if let Some(app_name) = terminal.map(str::trim).filter(|a| !a.is_empty()) {
        cmd.args(["-a", app_name]);
    }
    let status = cmd.arg(&path).status().map_err(|e| e.to_string())?;
    if !status.success() {
        let _ = std::fs::remove_file(&path);
        return Err("could not open the terminal app".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn open_in_terminal_cmd(
    app: AppHandle,
    directory: String,
    session_id: String,
    terminal: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        open_in_terminal(&app, &directory, &session_id, terminal.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn start_server(app: AppHandle) -> Result<ServerInfo, String> {
    tauri::async_runtime::spawn_blocking(move || start_blocking(&app))
        .await
        .map_err(|e| e.to_string())?
}

fn start_blocking(app: &AppHandle) -> Result<ServerInfo, String> {
    let state = app.state::<ServerState>();
    if let Some(info) = state.info.lock().unwrap().clone() {
        return Ok(info);
    }

    let pid_file = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("server.pid");
    kill_stale(&pid_file);

    let bin = resolve_opencode()?;
    let port = free_port()?;
    let password = random_hex(24)?;

    let mut child = Command::new(&bin)
        .args(["serve", "--hostname", "127.0.0.1", "--port", &port.to_string()])
        .env("OPENCODE_SERVER_PASSWORD", &password)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to spawn {}: {e}", bin.display()))?;

    if let Some(dir) = pid_file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&pid_file, child.id().to_string());

    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!("opencode exited during startup: {status}"));
        }
        if TcpStream::connect_timeout(
            &format!("127.0.0.1:{port}").parse().unwrap(),
            Duration::from_millis(300),
        )
        .is_ok()
        {
            break;
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            return Err("timed out waiting for opencode serve".into());
        }
        std::thread::sleep(Duration::from_millis(200));
    }

    let info = ServerInfo {
        url: format!("http://127.0.0.1:{port}"),
        password,
    };
    *state.child.lock().unwrap() = Some(child);
    *state.info.lock().unwrap() = Some(info.clone());
    Ok(info)
}

fn free_port() -> Result<u16, String> {
    let l = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    l.local_addr().map(|a| a.port()).map_err(|e| e.to_string())
}

fn random_hex(bytes: usize) -> Result<String, String> {
    let mut buf = vec![0u8; bytes];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut buf))
        .map_err(|e| e.to_string())?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

/// Kill an opencode server left behind by a previous crashed run.
fn kill_stale(pid_file: &PathBuf) {
    let Ok(pid) = std::fs::read_to_string(pid_file) else { return };
    let pid = pid.trim();
    if pid.is_empty() || !pid.chars().all(|c| c.is_ascii_digit()) {
        return;
    }
    let comm = Command::new("ps")
        .args(["-p", pid, "-o", "command="])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();
    if comm.contains("opencode") && comm.contains("serve") {
        let _ = Command::new("kill").arg(pid).status();
    }
    let _ = std::fs::remove_file(pid_file);
}

/// GUI apps don't inherit the shell PATH, so try several strategies.
pub fn resolve_opencode() -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("OPENCODE_BIN") {
        return Ok(PathBuf::from(p));
    }
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let cand = dir.join("opencode");
            if cand.is_file() {
                return Ok(cand);
            }
        }
    }
    let mut dirs: Vec<PathBuf> = vec![
        "/opt/homebrew/bin".into(),
        "/usr/local/bin".into(),
    ];
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        for rel in [".opencode/bin", ".bun/bin", ".local/bin", ".cargo/bin", ".npm-global/bin"] {
            dirs.push(home.join(rel));
        }
        for base in [home.join(".local/share/nvm"), home.join(".nvm/versions/node")] {
            if let Ok(rd) = std::fs::read_dir(&base) {
                let mut vers: Vec<PathBuf> = rd.flatten().map(|e| e.path().join("bin")).collect();
                vers.sort();
                vers.reverse();
                dirs.extend(vers);
            }
        }
    }
    for dir in dirs {
        let cand = dir.join("opencode");
        if cand.is_file() {
            return Ok(cand);
        }
    }
    let out = Command::new("zsh")
        .args(["-ilc", "command -v opencode"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| l.starts_with('/'))
        .map(PathBuf::from)
        .ok_or_else(|| "could not find the opencode binary (set OPENCODE_BIN)".to_string())
}
