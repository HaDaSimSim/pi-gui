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
    // PORT=0 → OS 가 빈 포트 할당. PI_GUI_PORT 로 강제 지정도 허용(테스트용).
    let port = std::env::var("PI_GUI_PORT").unwrap_or_else(|_| "0".to_string());
    let mut cmd = Command::new(node);
    cmd.arg(&entry);
    cmd.env("PORT", &port);
    cmd.stdout(Stdio::piped());
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[pi-gui] failed to spawn backend: {e}");
            return None;
        }
    };
    eprintln!("[pi-gui] backend spawned (pid {})", child.id());

    // 자식 stdout 을 읽어 "PI_GUI_PORT=<n>" 을 찾으면 프론트에 알린다.
    if let Some(stdout) = child.stdout.take() {
        let handle = app.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                eprintln!("[backend] {line}");
                if let Some(rest) = line.strip_prefix("PI_GUI_PORT=") {
                    if let Ok(p) = rest.trim().parse::<u16>() {
                        // 이벤트로도 쏘고, WebView 전역에도 직접 박는다(둘 다 안전망).
                        let _ = handle.emit("pi-gui://port", p);
                        if let Some(win) = handle.get_webview_window("main") {
                            let _ = win.eval(&format!("window.__PI_GUI_PORT__ = {p};"));
                        }
                    }
                }
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
