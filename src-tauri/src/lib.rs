// pi-gui — Tauri 네이티브 셸.
//
// 백엔드(server/index.ts, Hono + pi SDK)는 Node 로 돌아가야 하므로
// 앱 시작 시 자식 프로세스로 띄우고(127.0.0.1:4317), 종료 시 같이 내린다.
// 프론트(WebView)는 그 백엔드로 fetch/EventSource 한다.
//
// SECURITY: 백엔드는 127.0.0.1 에만 바인딩 (로컬 전용). Tauri 가 감싸도 동일.

use std::process::{Child, Command};
use std::sync::Mutex;

use tauri::{Manager, RunEvent};

// 자식 백엔드 프로세스 핸들 (종료 시 kill 용).
struct Backend(Mutex<Option<Child>>);

// dev 모드: PI_GUI_BACKEND_URL 이 있으면 거기에 붙고 자식을 안 띄운다
// (pnpm dev 가 이미 server 를 띄우는 경우). 없으면 직접 띄운다.
fn spawn_backend(app: &tauri::App) -> Option<Child> {
    if std::env::var("PI_GUI_NO_SPAWN").is_ok() {
        return None;
    }

    // 백엔드 진입점(server/index.ts)과 node 실행 파일 위치를 결정한다.
    //  - dev: 프로젝트 루트의 server/index.ts
    //  - prod: 리소스로 번들된 server/index.ts
    let resource_dir = app
        .path()
        .resource_dir()
        .ok()
        .map(|p| p.join("backend"));

    let dev_entry = std::env::var("PI_GUI_BACKEND_ENTRY").ok();

    let (entry, cwd) = if let Some(e) = dev_entry {
        let path = std::path::PathBuf::from(&e);
        let parent = path.parent().map(|p| p.to_path_buf());
        (path, parent)
    } else if let Some(rd) = resource_dir.filter(|p| p.join("server/index.ts").exists()) {
        (rd.join("server/index.ts"), Some(rd))
    } else {
        // 폴백: 현재 작업 디렉터리 기준.
        let cwd = std::env::current_dir().ok();
        (std::path::PathBuf::from("server/index.ts"), cwd)
    };

    let node = std::env::var("PI_GUI_NODE").unwrap_or_else(|_| "node".to_string());
    let port = std::env::var("PI_GUI_PORT").unwrap_or_else(|_| "4317".to_string());
    let mut cmd = Command::new(node);
    cmd.arg(&entry);
    cmd.env("PORT", &port);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }

    match cmd.spawn() {
        Ok(child) => {
            eprintln!("[pi-gui] backend spawned (pid {})", child.id());
            Some(child)
        }
        Err(e) => {
            eprintln!("[pi-gui] failed to spawn backend: {e}");
            None
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Backend(Mutex::new(None)))
        .setup(|app| {
            let child = spawn_backend(app);
            let state = app.state::<Backend>();
            *state.0.lock().unwrap() = child;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running pi-gui")
        .run(|app_handle, event| {
            if let RunEvent::ExitRequested { .. } = event {
                // 앱이 닫히면 백엔드 자식도 내린다.
                if let Some(state) = app_handle.try_state::<Backend>() {
                    if let Some(mut child) = state.0.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
            }
        });
}
