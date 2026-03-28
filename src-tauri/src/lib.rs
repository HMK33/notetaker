mod recording;
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
) -> Result<(), String> {
    recording::start_recording(
        state.inner().clone(),
        app,
        device_name,
        recordings_path.unwrap_or_default(),
    )
    .map_err(|e| e.to_string())
}

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
) -> Result<TranscriptResult, String> {
    let model = model.unwrap_or_else(|| "mlx-community/whisper-large-v3".to_string());
    let python_path = python_path.unwrap_or_else(|| "/usr/bin/python3".to_string());
    let prompt = initial_prompt.unwrap_or_default();
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
            .transcribe(&audio_path, &prompt)
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
        .invoke_handler(tauri::generate_handler![
            list_audio_devices,
            start_recording,
            stop_recording,
            pause_recording,
            resume_recording,
            run_whisper,
            check_python_env,
            delete_audio_file,
            open_recordings_folder,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
