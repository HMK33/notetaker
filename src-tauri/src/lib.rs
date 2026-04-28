mod recording;
#[cfg(target_os = "macos")]
mod sck_capture;
mod whisper_runner;

use std::sync::{Arc, Mutex};
use recording::{AudioDevice, RecordingResult, RecordingState};
use whisper_runner::{PythonEnvStatus, TranscriptResult, WhisperServer};
use tauri::{Manager, State};

type RecordingStateHandle = Arc<RecordingState>;
type WhisperServerHandle = Arc<Mutex<Option<WhisperServer>>>;

#[tauri::command]
fn list_audio_devices() -> Result<Vec<AudioDevice>, String> {
    recording::list_audio_devices().map_err(|e| e.to_string())
}

#[tauri::command]
fn start_recording(
    app: tauri::AppHandle,
    state: State<RecordingStateHandle>,
    device_name: Option<String>,
    recordings_path: Option<String>,
    audio_source: Option<String>,
) -> Result<(), String> {
    let source = audio_source.unwrap_or_else(|| "microphone".to_string());
    let recordings_path = recordings_path.unwrap_or_default();

    if source == "system_and_mic" {
        #[cfg(target_os = "macos")]
        {
            return recording::start_recording_system_audio(
                state.inner().clone(),
                app,
                recordings_path,
                /* capture_mic */ true,
            )
            .map_err(|e| e.to_string());
        }
        #[cfg(not(target_os = "macos"))]
        {
            return Err("시스템 오디오 캡처는 macOS에서만 지원됩니다.".to_string());
        }
    }

    recording::start_recording(
        state.inner().clone(),
        app,
        device_name,
        recordings_path,
    )
    .map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn check_screen_recording_permission() -> bool {
    recording::check_screen_recording_permission()
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn request_screen_recording_permission() -> bool {
    recording::request_screen_recording_permission()
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn check_screen_recording_permission() -> bool { true }

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn request_screen_recording_permission() -> bool { true }

#[tauri::command]
fn stop_recording(app: tauri::AppHandle, state: State<RecordingStateHandle>) -> Result<RecordingResult, String> {
    recording::stop_recording(state.inner().clone(), app).map_err(|e| e.to_string())
}

#[tauri::command]
async fn run_whisper(
    app: tauri::AppHandle,
    whisper_server: State<'_, WhisperServerHandle>,
    audio_path: String,
    model: Option<String>,
    python_path: Option<String>,
    initial_prompt: Option<String>,
    diarize: Option<bool>,
    hf_token: Option<String>,
) -> Result<TranscriptResult, String> {
    let model = model.unwrap_or_else(|| "mlx-community/whisper-large-v3-mlx".to_string());
    let python_path = python_path.unwrap_or_else(|| "/usr/bin/python3".to_string());
    let prompt = initial_prompt.unwrap_or_default();
    let diarize = diarize.unwrap_or(false);
    let hf_token = hf_token.unwrap_or_default();
    let script_path = get_script_path(&app);
    let server_handle = whisper_server.inner().clone();

    tokio::task::spawn_blocking(move || {
        let mut guard = server_handle.lock().unwrap();

        // 서버가 없거나 모델/Python 경로가 달라진 경우 재시작
        let needs_restart = match guard.as_ref() {
            None => true,
            Some(s) => s.model != model || s.python_path != python_path,
        };

        if needs_restart {
            *guard = None; // 기존 서버 Drop → 프로세스 kill
            match WhisperServer::start(&python_path, &script_path, &model) {
                Ok(server) => *guard = Some(server),
                Err(e) => return Err(e.to_string()),
            }
        }

        let result = guard
            .as_mut()
            .unwrap()
            .transcribe(&audio_path, &prompt, diarize, &hf_token)
            .map_err(|e| e.to_string());

        // 전사 실패 시 서버 리셋 (다음 호출 시 재시작)
        if result.is_err() {
            *guard = None;
        }

        result
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn check_python_env(
    app: tauri::AppHandle,
    python_path: Option<String>,
) -> PythonEnvStatus {
    let python_path = python_path.unwrap_or_else(|| "/usr/bin/python3".to_string());
    whisper_runner::check_python_env(&app, &python_path).await
}

#[derive(serde::Serialize)]
struct ClaudeEnvStatus {
    installed: bool,
    claude_path: String,
    version: Option<String>,
    error: Option<String>,
}

/// Claude CLI 실행 가능 여부 + 버전 확인. `claude --version` 호출.
#[tauri::command]
async fn check_claude_env(claude_path: Option<String>) -> ClaudeEnvStatus {
    let path = claude_path.unwrap_or_else(|| "claude".to_string());
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        tokio::process::Command::new(&path)
            .arg("--version")
            .output(),
    )
    .await;

    match result {
        Ok(Ok(output)) if output.status.success() => {
            let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
            ClaudeEnvStatus {
                installed: true,
                claude_path: path,
                version: Some(version),
                error: None,
            }
        }
        Ok(Ok(output)) => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            ClaudeEnvStatus {
                installed: false,
                claude_path: path,
                version: None,
                error: Some(if stderr.is_empty() { "실행 실패".to_string() } else { stderr }),
            }
        }
        Ok(Err(e)) => ClaudeEnvStatus {
            installed: false,
            claude_path: path,
            version: None,
            error: Some(format!("실행 불가: {e}")),
        },
        Err(_) => ClaudeEnvStatus {
            installed: false,
            claude_path: path,
            version: None,
            error: Some("응답 시간 초과 (5초)".to_string()),
        },
    }
}

/// 흔한 설치 위치들에서 mlx-whisper가 작동하는 python 인터프리터를 탐색.
/// 프로젝트 .venv를 우선 시도 (개발 환경), 그 다음 시스템/홈브루.
#[tauri::command]
async fn auto_detect_python_path(app: tauri::AppHandle) -> Option<String> {
    use tauri::Manager;
    let home = std::env::var("HOME").unwrap_or_default();

    // 앱 리소스 디렉터리(빌드 시 .venv 동봉) → 개발 cwd → 홈브루/시스템
    let mut candidates: Vec<String> = Vec::new();
    if let Ok(resource) = app.path().resource_dir() {
        candidates.push(
            resource.join(".venv").join("bin").join("python").to_string_lossy().into_owned(),
        );
    }
    candidates.extend([
        format!("{home}/Coding/notetaker/.venv/bin/python"),
        "/opt/homebrew/bin/python3".to_string(),
        "/usr/local/bin/python3".to_string(),
        "/usr/bin/python3".to_string(),
        "python3".to_string(),
    ]);

    for path in candidates {
        let status = whisper_runner::check_python_env(&app, &path).await;
        if status.installed {
            return Some(path);
        }
    }
    None
}

/// 흔한 설치 위치들에서 claude 바이너리를 찾아 첫 번째로 실행 가능한 경로 반환.
#[tauri::command]
async fn auto_detect_claude_path() -> Option<String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let candidates = vec![
        "claude".to_string(),
        "/opt/homebrew/bin/claude".to_string(),
        "/usr/local/bin/claude".to_string(),
        format!("{home}/.local/bin/claude"),
        format!("{home}/.claude/local/claude"),
        format!("{home}/.npm-global/bin/claude"),
        format!("{home}/.bun/bin/claude"),
    ];

    for path in candidates {
        let ok = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            tokio::process::Command::new(&path).arg("--version").output(),
        )
        .await;
        if let Ok(Ok(output)) = ok {
            if output.status.success() {
                return Some(path);
            }
        }
    }
    None
}

#[tauri::command]
fn pause_recording(state: State<RecordingStateHandle>) -> Result<(), String> {
    recording::pause_recording(state.inner().clone()).map_err(|e| e.to_string())
}

#[tauri::command]
fn resume_recording(state: State<RecordingStateHandle>) -> Result<(), String> {
    recording::resume_recording(state.inner().clone()).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_audio_file(audio_path: String) -> Result<(), String> {
    if std::path::Path::new(&audio_path).exists() {
        std::fs::remove_file(&audio_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn run_claude_summary(
    prompt: String,
    claude_path: Option<String>,
    claude_model: Option<String>,
) -> Result<String, String> {
    use tokio::io::AsyncWriteExt;

    let claude_bin = claude_path.unwrap_or_else(|| "claude".to_string());

    let mut cmd = tokio::process::Command::new(&claude_bin);
    cmd.args(["--print", "--output-format", "json"]);
    if let Some(model) = claude_model.as_deref().filter(|m| !m.is_empty()) {
        cmd.args(["--model", model]);
    }

    let mut child = cmd
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true) // 타임아웃 등으로 drop될 때 프로세스 자동 kill
        .spawn()
        .map_err(|e| format!("Claude 실행 실패 ({claude_bin}): {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(prompt.as_bytes()).await
            .map_err(|e| format!("stdin 쓰기 실패: {e}"))?;
        stdin.shutdown().await
            .map_err(|e| format!("stdin 종료 실패: {e}"))?;
    }

    let output = tokio::time::timeout(
        std::time::Duration::from_secs(300), // 5분 타임아웃
        child.wait_with_output(),
    )
    .await
    .map_err(|_| "요약 시간 초과 (5분). Claude CLI가 응답하지 않습니다. CLI 경로·로그인 상태·인터넷 연결을 확인하세요.".to_string())?
    .map_err(|e| format!("Claude 응답 대기 실패: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Claude 오류: {stderr}"));
    }

    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[tauri::command]
fn open_recordings_folder(recordings_path: Option<String>) -> Result<(), String> {
    let dir = recording::get_recordings_dir(&recordings_path.unwrap_or_default());
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    open::that(&dir).map_err(|e| e.to_string())?;
    Ok(())
}

fn get_script_path(app: &tauri::AppHandle) -> String {
    if cfg!(debug_assertions) {
        let manifest_dir = env!("CARGO_MANIFEST_DIR");
        let path = std::path::Path::new(manifest_dir)
            .parent()
            .unwrap_or_else(|| std::path::Path::new("."))
            .join("scripts")
            .join("transcribe.py");
        path.to_string_lossy().to_string()
    } else {
        app.path()
            .resource_dir()
            .map(|p: std::path::PathBuf| p.join("scripts").join("transcribe.py"))
            .map(|p: std::path::PathBuf| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| "scripts/transcribe.py".to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let recording_state: RecordingStateHandle = Arc::new(RecordingState::default());
    let whisper_server: WhisperServerHandle = Arc::new(Mutex::new(None));

    tauri::Builder::default()
        .manage(recording_state)
        .manage(whisper_server)
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            list_audio_devices,
            start_recording,
            stop_recording,
            pause_recording,
            resume_recording,
            run_whisper,
            check_python_env,
            check_claude_env,
            auto_detect_claude_path,
            auto_detect_python_path,
            delete_audio_file,
            open_recordings_folder,
            run_claude_summary,
            check_screen_recording_permission,
            request_screen_recording_permission,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
