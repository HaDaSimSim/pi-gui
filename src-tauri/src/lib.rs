// pi-gui — Tauri native shell.
//
// The backend (server/index.ts, Hono + pi SDK) must run on Node, so we
// spawn it as a child process on app startup and shut it down on exit.
// The frontend (WebView) does fetch/EventSource against that backend.
//
// The port is dynamic: spawning the backend with PORT=0 lets the OS pick a
// free port, and the backend prints "PI_GUI_PORT=<n>" on stdout. We read that
// and inject it into the WebView as window.__PI_GUI_PORT__ → port collisions
// (EADDRINUSE) disappear.
//
// SECURITY: the backend binds to 127.0.0.1 only (local-only). Same even when
// wrapped by Tauri.

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_opener::OpenerExt;

// Child backend process handle (for kill on exit).
struct Backend(Mutex<Option<Child>>);

// Whether there is an in-progress (streaming/live) session — updated by the
// frontend. Used for the quit confirmation.
struct Busy(Arc<AtomicBool>);

// One live session as surfaced in the tray menu.
#[derive(Clone, Default, serde::Deserialize)]
struct TraySession {
    #[serde(default)]
    name: String,
    #[serde(default)]
    streaming: bool,
}

// Snapshot the frontend pushes for the tray (sessions/remote/devices). The port
// is owned by Rust (parsed from the backend stdout), so it is merged separately
// and is not part of the frontend payload.
#[derive(Clone, Default, serde::Deserialize)]
struct TraySnapshot {
    #[serde(default)]
    remote_on: bool,
    #[serde(default)]
    devices: Vec<String>,
    #[serde(default)]
    sessions: Vec<TraySession>,
}

// Full tray state = Rust-owned port + the frontend snapshot.
#[derive(Default)]
struct TrayStateInner {
    port: Option<u16>,
    snap: TraySnapshot,
}
struct TrayState(Mutex<TrayStateInner>);

// Whether a quit is actually in progress (prevents re-entry after the
// confirmation passes).
static QUITTING: AtomicBool = AtomicBool::new(false);

// Determine the Node executable location. macOS GUI apps do not inherit the
// shell PATH, so we prefer the bundled sidecar (Contents/MacOS/node) first.
//  1) PI_GUI_NODE       — explicit override (test/dev)
//  2) sidecar next to the main executable (prod .app: Contents/MacOS/node;
//     dev/per-arch build: target/<profile>/node)
//  3) "node" on PATH — last-resort fallback on a machine with node installed
fn resolve_node() -> std::path::PathBuf {
    if let Ok(n) = std::env::var("PI_GUI_NODE") {
        return std::path::PathBuf::from(n);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let cand = dir.join("node");
            if cand.exists() {
                return cand;
            }
        }
    }
    std::path::PathBuf::from("node")
}

fn spawn_backend(app: &tauri::AppHandle) -> Option<Child> {
    if std::env::var("PI_GUI_NO_SPAWN").is_ok() {
        // dev: the backend is already spawned externally (pnpm dev). Assumes the
        // port is fixed at 4317.
        return None;
    }

    // Determine the backend entry point (server/index.ts) and the node
    // executable location.
    //  - dev: specified via PI_GUI_BACKEND_ENTRY
    //  - prod: backend/server/index.ts bundled as a resource
    let resource_dir = app.path().resource_dir().ok().map(|p| p.join("backend"));
    let dev_entry = std::env::var("PI_GUI_BACKEND_ENTRY").ok();

    let (entry, cwd) = if let Some(e) = dev_entry {
        let path = std::path::PathBuf::from(&e);
        let parent = path.parent().map(|p| p.to_path_buf());
        (path, parent)
    } else if let Some(rd) = resource_dir.filter(|p| p.join("server/index.ts").exists()) {
        (rd.join("server/index.ts"), Some(rd))
    } else {
        let cwd = std::env::current_dir().ok();
        (std::path::PathBuf::from("server/index.ts"), cwd)
    };

    let node = resolve_node();
    // PORT=0 -> OS picks a free port. PI_GUI_PORT forces a fixed port (test use).
    let port = std::env::var("PI_GUI_PORT").unwrap_or_else(|_| "0".to_string());
    let mut cmd = Command::new(&node);
    cmd.arg(&entry);
    cmd.env("PORT", &port);
    // Lets the backend detect the death of its parent (this process) so it does
    // not linger as an orphan.
    cmd.env("PI_GUI_PARENT_PID", std::process::id().to_string());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped()); // pipe stderr too so crash logs are not lost
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }

    // Also persist backend logs to a file (so a windowless prod app can be diagnosed).
    let log_path = app
        .path()
        .app_log_dir()
        .ok()
        .map(|d| {
            let _ = std::fs::create_dir_all(&d);
            d.join("backend.log")
        })
        .unwrap_or_else(|| std::env::temp_dir().join("pi-gui-backend.log"));
    eprintln!("[pi-gui] backend log: {}", log_path.display());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[pi-gui] failed to spawn backend: {e}");
            return None;
        }
    };
    let pid = child.id();
    eprintln!("[pi-gui] backend spawned (pid {pid})");

    // Shared log file handle for the stdout/stderr reader threads.
    let log_file = std::sync::Arc::new(std::sync::Mutex::new(
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .ok(),
    ));
    let write_log = move |lf: &std::sync::Arc<std::sync::Mutex<Option<std::fs::File>>>,
                          line: &str| {
        if let Ok(mut g) = lf.lock() {
            if let Some(f) = g.as_mut() {
                use std::io::Write;
                let _ = writeln!(f, "{line}");
            }
        }
    };

    // Read stdout: find "PI_GUI_PORT=<n>" and tell the frontend; log the rest.
    if let Some(stdout) = child.stdout.take() {
        let handle = app.clone();
        let lf = log_file.clone();
        let wl = write_log;
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                eprintln!("[backend] {line}");
                wl(&lf, &format!("[out] {line}"));
                if let Some(rest) = line.strip_prefix("PI_GUI_PORT=") {
                    if let Ok(p) = rest.trim().parse::<u16>() {
                        let _ = handle.emit("pi-gui://port", p);
                        if let Some(win) = handle.get_webview_window("main") {
                            let _ = win.eval(format!("window.__PI_GUI_PORT__ = {p};"));
                        }
                        // Record the port for the tray and refresh it.
                        if let Some(ts) = handle.try_state::<TrayState>() {
                            ts.0.lock().unwrap().port = Some(p);
                        }
                        rebuild_tray(&handle);
                    }
                }
            }
        });
    }

    // Read stderr too (Node crash/exception messages come out here).
    if let Some(stderr) = child.stderr.take() {
        let lf = log_file.clone();
        let wl = write_log;
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                eprintln!("[backend!] {line}");
                wl(&lf, &format!("[err] {line}"));
            }
        });
    }

    Some(child)
}

// The frontend reports whether there is an in-progress (streaming/live)
// session. Used for the quit confirmation.
#[tauri::command]
fn set_busy(busy: bool, state: tauri::State<Busy>) {
    state.0.store(busy, Ordering::SeqCst);
}

// The frontend pushes a tray snapshot (remote state, devices, live sessions)
// whenever it changes. Rust merges in the backend port and rebuilds the tray.
#[tauri::command]
fn set_tray_state(snapshot: TraySnapshot, app: tauri::AppHandle) {
    if let Some(ts) = app.try_state::<TrayState>() {
        let mut g = ts.0.lock().unwrap();
        g.snap = snapshot;
    }
    rebuild_tray(&app);
}

// Tray menu IDs. Dynamic per-session items use the "tray-session:<idx>" scheme.
const TRAY_SHOW: &str = "tray-show";
const TRAY_ADD_DEVICE: &str = "tray-add-device";
const TRAY_REMOTE_TOGGLE: &str = "tray-remote-toggle";
const TRAY_BACKEND: &str = "tray-backend";
const TRAY_QUIT: &str = "tray-quit";
const TRAY_SESSION_PREFIX: &str = "tray-session:";

// Rebuild the whole tray menu + icon tooltip from the current TrayState. Called
// on every snapshot change. Observation-only — it never drives a turn.
fn rebuild_tray(app: &tauri::AppHandle) {
    let (port, snap) = match app.try_state::<TrayState>() {
        Some(ts) => {
            let g = ts.0.lock().unwrap();
            (g.port, g.snap.clone())
        }
        None => return,
    };
    let Some(tray) = app.tray_by_id("main") else {
        return;
    };

    let mut builder = MenuBuilder::new(app);

    // Remote control toggle + connected devices. Only shown when remote is on;
    // the desktop UI gates remote off by default (no dead button in the tray).
    if snap.remote_on {
        if let Ok(item) =
            MenuItemBuilder::with_id(TRAY_REMOTE_TOGGLE, "Remote Control: On").build(app)
        {
            builder = builder.item(&item);
        }
        if !snap.devices.is_empty() {
            let label = format!("Connected: {}", snap.devices.join(", "));
            if let Ok(item) = MenuItemBuilder::with_id("tray-devices", label)
                .enabled(false)
                .build(app)
            {
                builder = builder.item(&item);
            }
        }
        builder = builder.separator();
    }

    // Active sessions.
    let streaming = snap.sessions.iter().filter(|s| s.streaming).count();
    let header = if snap.sessions.is_empty() {
        "No active sessions".to_string()
    } else {
        format!("Active sessions: {} streaming", streaming)
    };
    if let Ok(item) = MenuItemBuilder::with_id("tray-sessions-header", header)
        .enabled(false)
        .build(app)
    {
        builder = builder.item(&item);
    }
    for (idx, s) in snap.sessions.iter().enumerate().take(12) {
        let dot = if s.streaming { "▸ " } else { "  " };
        let name = if s.name.is_empty() {
            "(untitled)"
        } else {
            &s.name
        };
        let label = format!("{dot}{name}");
        if let Ok(item) =
            MenuItemBuilder::with_id(format!("{TRAY_SESSION_PREFIX}{idx}"), label).build(app)
        {
            builder = builder.item(&item);
        }
    }
    builder = builder.separator();

    // Window + pairing.
    if let Ok(item) = MenuItemBuilder::with_id(TRAY_SHOW, "Show pi-gui").build(app) {
        builder = builder.item(&item);
    }
    if let Ok(item) = MenuItemBuilder::with_id(TRAY_ADD_DEVICE, "Add device…").build(app) {
        builder = builder.item(&item);
    }
    builder = builder.separator();

    // Backend health.
    let backend_label = match port {
        Some(p) => format!("Backend: :{p} ✓"),
        None => "Backend: starting…".to_string(),
    };
    if let Ok(item) = MenuItemBuilder::with_id(TRAY_BACKEND, backend_label).build(app) {
        builder = builder.item(&item);
    }
    if let Ok(item) = MenuItemBuilder::with_id(TRAY_QUIT, "Quit pi-gui").build(app) {
        builder = builder.item(&item);
    }

    if let Ok(menu) = builder.build() {
        let _ = tray.set_menu(Some(menu));
    }

    // Tooltip mirrors the headline state.
    let tip = if streaming > 0 {
        format!("pi-gui — {streaming} streaming")
    } else if snap.remote_on {
        "pi-gui — remote on".to_string()
    } else {
        "pi-gui".to_string()
    };
    let _ = tray.set_tooltip(Some(&tip));
}

// Handle a tray menu click by id. Window/quit are handled in Rust; the rest are
// emitted to the frontend (it owns remote/pairing/session-focus logic).
fn handle_tray_event(app: &tauri::AppHandle, id: &str) {
    match id {
        TRAY_SHOW => show_main_window(app),
        TRAY_QUIT => {
            QUITTING.store(true, Ordering::SeqCst);
            app.exit(0);
        }
        TRAY_ADD_DEVICE => {
            show_main_window(app);
            let _ = app.emit("pi-gui://tray", "add-device");
        }
        TRAY_REMOTE_TOGGLE => {
            let _ = app.emit("pi-gui://tray", "remote-toggle");
        }
        TRAY_BACKEND => {
            show_main_window(app);
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.eval(
                    "window.dispatchEvent(new KeyboardEvent('keydown',{key:'l',metaKey:true,shiftKey:true}))",
                );
            }
        }
        other if other.starts_with(TRAY_SESSION_PREFIX) => {
            if let Some(idx) = other.strip_prefix(TRAY_SESSION_PREFIX) {
                show_main_window(app);
                let _ = app.emit("pi-gui://tray-session", idx.to_string());
            }
        }
        _ => {}
    }
}

// Re-show + focus the main window (it may have been hidden by the close button).
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

// macOS menu bar. The app menu name comes from productName("π (pi)").
// A DevTools toggle (Cmd+Opt+I) is placed in the View menu to ease
// backend/frontend debugging.
fn build_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    // App menu (standard about / hide / quit, etc.).
    let app_menu = SubmenuBuilder::new(app, "π (pi)")
        .about(None)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    // Edit menu (copy/paste — needed for text input).
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    // View menu — Refresh (reloads only the WebView, not the backend), DevTools toggle.
    let refresh_item = MenuItemBuilder::with_id("refresh-web", "Refresh")
        .accelerator("CmdOrCtrl+R")
        .build(app)?;
    let devtools_item = MenuItemBuilder::with_id("toggle-devtools", "Toggle Developer Tools")
        .accelerator("CmdOrCtrl+Alt+I")
        .build(app)?;
    let log_item = MenuItemBuilder::with_id("backend-log", "Backend Log")
        .accelerator("CmdOrCtrl+Shift+L")
        .build(app)?;
    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&refresh_item)
        .separator()
        .item(&devtools_item)
        .item(&log_item)
        .separator()
        .fullscreen()
        .build()?;

    // Window menu.
    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .close_window()
        .build()?;

    // Help menu. Naming a submenu "Help" + set_as_help_menu_for_nsapp makes macOS
    // attach its native search box (searches all menu items) automatically.
    let docs_item = MenuItemBuilder::with_id("help-docs", "pi-gui Documentation").build(app)?;
    let help_menu = SubmenuBuilder::new(app, "Help").item(&docs_item).build()?;
    #[cfg(target_os = "macos")]
    let _ = help_menu.set_as_help_menu_for_nsapp();

    MenuBuilder::new(app)
        .item(&app_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&window_menu)
        .item(&help_menu)
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let busy = Arc::new(AtomicBool::new(false));
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(Backend(Mutex::new(None)))
        .manage(Busy(busy.clone()))
        .manage(TrayState(Mutex::new(TrayStateInner::default())))
        .invoke_handler(tauri::generate_handler![set_busy, set_tray_state])
        .setup(|app| {
            let handle = app.handle();
            let child = spawn_backend(handle);
            let state = app.state::<Backend>();
            *state.0.lock().unwrap() = child;

            // Build the menu bar + DevTools toggle event.
            match build_menu(handle) {
                Ok(menu) => {
                    let _ = app.set_menu(menu);
                    app.on_menu_event(|app, event| {
                        if event.id() == "toggle-devtools" {
                            if let Some(win) = app.get_webview_window("main") {
                                if win.is_devtools_open() {
                                    win.close_devtools();
                                } else {
                                    win.open_devtools();
                                }
                            }
                        } else if event.id() == "backend-log" {
                            // Inject a Cmd+Shift+L key event into the frontend to toggle the log viewer.
                            if let Some(win) = app.get_webview_window("main") {
                                let _ = win.eval("window.dispatchEvent(new KeyboardEvent('keydown',{key:'l',metaKey:true,shiftKey:true}))");
                            }
                        } else if event.id() == "refresh-web" {
                            // Reload only the WebView (frontend). The Node backend child
                            // keeps running, so sessions/locks survive the reload.
                            if let Some(win) = app.get_webview_window("main") {
                                let _ = win.eval("window.location.reload()");
                            }
                        } else if event.id() == "help-docs" {
                            // Open the project docs in the user's default browser.
                            let _ = app
                                .opener()
                                .open_url("https://github.com/HaDaSimSim/pi-gui#readme", None::<&str>);
                        }
                    });
                }
                Err(e) => eprintln!("[pi-gui] menu build failed: {e}"),
            }

            // macOS menu-bar tray (status item). Doubles as the remote-control
            // panel so a hidden window still exposes full control. The menu is
            // rebuilt dynamically from TrayState (see rebuild_tray).
            let tray_icon = app.default_window_icon().cloned();
            let mut tray_builder = TrayIconBuilder::with_id("main")
                .tooltip("pi-gui")
                .on_menu_event(|app, event| handle_tray_event(app, event.id().as_ref()));
            if let Some(icon) = tray_icon {
                tray_builder = tray_builder.icon(icon);
            }
            match tray_builder.build(app) {
                Ok(_) => rebuild_tray(handle),
                Err(e) => eprintln!("[pi-gui] tray build failed: {e}"),
            }

            // Window X close → hide to background instead of quitting. Tab/session
            // state is kept in memory.
            // Actual quit only happens via dock right-click→Quit (or Cmd+Q) →
            // ExitRequested.
            if let Some(win) = app.get_webview_window("main") {
                let w = win.clone();
                win.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        if !QUITTING.load(Ordering::SeqCst) {
                            api.prevent_close();
                            let _ = w.hide();
                        }
                    }
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running pi-gui")
        .run(move |app_handle, event| {
            // macOS: clicking the dock icon (when the window was hidden by the
            // close button) fires Reopen. Re-show the hidden window — otherwise
            // the app stays running with no way to get the window back.
            #[cfg(target_os = "macos")]
            if let RunEvent::Reopen { .. } = event {
                show_main_window(app_handle);
                return;
            }
            if let RunEvent::ExitRequested { api, .. } = event {
                // If a quit is already in progress (confirmation passed), proceed.
                if QUITTING.load(Ordering::SeqCst) {
                    if let Some(state) = app_handle.try_state::<Backend>() {
                        if let Some(mut child) = state.0.lock().unwrap().take() {
                            let _ = child.kill();
                        }
                    }
                    return;
                }
                // If there are running sessions, show a native confirmation dialog.
                if busy.load(Ordering::SeqCst) {
                    api.prevent_exit();
                    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
                    let h = app_handle.clone();
                    app_handle
                        .dialog()
                        .message("There are running sessions. Quit anyway?")
                        .title("Quit pi-gui?")
                        .kind(MessageDialogKind::Warning)
                        .buttons(MessageDialogButtons::OkCancelCustom("Quit".into(), "Cancel".into()))
                        .show(move |confirmed| {
                            if confirmed {
                                QUITTING.store(true, Ordering::SeqCst);
                                h.exit(0);
                            }
                        });
                } else {
                    // No running sessions → quit directly + kill the backend.
                    QUITTING.store(true, Ordering::SeqCst);
                    if let Some(state) = app_handle.try_state::<Backend>() {
                        if let Some(mut child) = state.0.lock().unwrap().take() {
                            let _ = child.kill();
                        }
                    }
                }
            }
        });
}
