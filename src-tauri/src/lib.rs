// pi-gui — Tauri 네이티브 셸.
//
// 백엔드(server/index.ts, Hono + pi SDK)는 Node 로 돌아가야 하므로
// 앱 시작 시 자식 프로세스로 띄우고, 종료 시 같이 내린다.
// 프론트(WebView)는 그 백엔드로 fetch/EventSource 한다.
//
// 포트는 동적이다: 백엔드를 PORT=0 으로 띄우면 OS 가 빈 포트를 골라주고,
// 백엔드가 stdout 에 "PI_GUI_PORT=<n>" 을 출력한다. 그걸 읽어 WebView 에
// window.__PI_GUI_PORT__ 로 주입한다 → 포트 충돌(EADDRINUSE)이 사라진다.
//
// SECURITY: 백엔드는 127.0.0.1 에만 바인딩 (로컬 전용). Tauri 가 감싸도 동일.

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Emitter, Manager, RunEvent, WindowEvent};

// 자식 백엔드 프로세스 핸들 (종료 시 kill 용).
struct Backend(Mutex<Option<Child>>);

// 진행 중(스트리밍/라이브) 세션이 있는지 — 프론트에서 갱신. quit 확인용.
struct Busy(Arc<AtomicBool>);

// 실제로 종료 진행 중인지 (확인 통과 후 재진입 방지).
static QUITTING: AtomicBool = AtomicBool::new(false);

fn spawn_backend(app: &tauri::AppHandle) -> Option<Child> {
    if std::env::var("PI_GUI_NO_SPAWN").is_ok() {
        // dev: 외부에서 이미 백엔드를 띄운 경우(pnpm dev). 포트는 4317 고정 가정.
        return None;
    }

    // 백엔드 진입점(server/index.ts)과 node 실행 파일 위치를 결정한다.
    //  - dev: PI_GUI_BACKEND_ENTRY 로 지정
    //  - prod: 리소스로 번들된 backend/server/index.ts
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

    let node = std::env::var("PI_GUI_NODE").unwrap_or_else(|_| "node".to_string());
    // PORT=0 -> OS picks a free port. PI_GUI_PORT forces a fixed port (test use).
    let port = std::env::var("PI_GUI_PORT").unwrap_or_else(|_| "0".to_string());
    let mut cmd = Command::new(node);
    cmd.arg(&entry);
    cmd.env("PORT", &port);
    // 백엔드가 부모(이 프로세스) 사망을 감지해 orphan 으로 안 남게 한다.
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
        let wl = write_log.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                eprintln!("[backend] {line}");
                wl(&lf, &format!("[out] {line}"));
                if let Some(rest) = line.strip_prefix("PI_GUI_PORT=") {
                    if let Ok(p) = rest.trim().parse::<u16>() {
                        let _ = handle.emit("pi-gui://port", p);
                        if let Some(win) = handle.get_webview_window("main") {
                            let _ = win.eval(&format!("window.__PI_GUI_PORT__ = {p};"));
                        }
                    }
                }
            }
        });
    }

    // Read stderr too (Node crash/exception messages come out here).
    if let Some(stderr) = child.stderr.take() {
        let lf = log_file.clone();
        let wl = write_log.clone();
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

// 프론트가 진행 중(스트리밍/라이브) 세션 여부를 알려준다. quit 확인용.
#[tauri::command]
fn set_busy(busy: bool, state: tauri::State<Busy>) {
    state.0.store(busy, Ordering::SeqCst);
}

// macOS 메뉴 바. 앱 메뉴 이름은 productName("π (pi)")에서 온다.
// View 메뉴에 DevTools 토글(Cmd+Opt+I)을 둬서 백엔드/프론트 디버깅을 쉽게 한다.
fn build_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    // 앱 메뉴 (about / hide / quit 등 표준).
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

    // 편집 메뉴 (복사/붙여넣기 — 텍스트 입력에 필요).
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    // 보기 메뉴 — DevTools 토글.
    let devtools_item = MenuItemBuilder::with_id("toggle-devtools", "Toggle Developer Tools")
        .accelerator("CmdOrCtrl+Alt+I")
        .build(app)?;
    let log_item = MenuItemBuilder::with_id("backend-log", "Backend Log")
        .accelerator("CmdOrCtrl+Shift+L")
        .build(app)?;
    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&devtools_item)
        .item(&log_item)
        .separator()
        .fullscreen()
        .build()?;

    // 창 메뉴.
    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .close_window()
        .build()?;

    MenuBuilder::new(app)
        .item(&app_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&window_menu)
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let busy = Arc::new(AtomicBool::new(false));
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Backend(Mutex::new(None)))
        .manage(Busy(busy.clone()))
        .invoke_handler(tauri::generate_handler![set_busy])
        .setup(|app| {
            let handle = app.handle();
            let child = spawn_backend(handle);
            let state = app.state::<Backend>();
            *state.0.lock().unwrap() = child;

            // 메뉴 바 구성 + DevTools 토글 이벤트.
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
                            // 프론트에 Cmd+Shift+L 키 이벤트를 주입해 로그 뷰어 토글.
                            if let Some(win) = app.get_webview_window("main") {
                                let _ = win.eval("window.dispatchEvent(new KeyboardEvent('keydown',{key:'l',metaKey:true,shiftKey:true}))");
                            }
                        }
                    });
                }
                Err(e) => eprintln!("[pi-gui] menu build failed: {e}"),
            }

            // 창 X 닫기 → 종료 아닌 백그라운드로 hide. 탭/세션 상태가 메모리에 유지된다.
            // 실제 종료는 dock 우클릭→Quit (또는 Cmd+Q) → ExitRequested 에서만.
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
            if let RunEvent::ExitRequested { api, .. } = event {
                // 이미 확인 통과해 종료 중이면 그대로 진행.
                if QUITTING.load(Ordering::SeqCst) {
                    if let Some(state) = app_handle.try_state::<Backend>() {
                        if let Some(mut child) = state.0.lock().unwrap().take() {
                            let _ = child.kill();
                        }
                    }
                    return;
                }
                // 진행 중인 세션이 있으면 네이티브 확인 다이얼로그.
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
                    // 진행 중 세션 없음 → 그대로 종료 + 백엔드 kill.
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
