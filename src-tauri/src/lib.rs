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

/// JS에서 invoke('run_whisper', { ... })로 넘겨주는 옵션 묶음.
/// 인자 너무 많아서 구조체로 묶음. 모두 optional이라 누락 시 기본값.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct WhisperOptions {
    audio_path: String,
    model: Option<String>,
    python_path: Option<String>,
    initial_prompt: Option<String>,
    diarize: Option<bool>,
    hf_token: Option<String>,
}

#[tauri::command]
async fn run_whisper(
    app: tauri::AppHandle,
    whisper_server: State<'_, WhisperServerHandle>,
    options: WhisperOptions,
) -> Result<TranscriptResult, String> {
    let WhisperOptions { audio_path, model, python_path, initial_prompt, diarize, hf_token } = options;
    let model = model.unwrap_or_else(|| "mlx-community/whisper-large-v3-mlx".to_string());
    let python_path = match python_path.as_deref() {
        Some(p) if !p.is_empty() => p.to_string(),
        _ => auto_detect_python_path(app.clone())
            .await
            .ok_or_else(|| {
                "mlx-whisper가 설치된 Python을 자동 탐색에서 찾지 못했습니다.\n\n해결 방법:\n1. Apple Silicon Mac 확인 (Intel Mac은 mlx-whisper 미지원)\n2. 터미널에서 설치:\n   pip3 install mlx-whisper\n3. 설정 → Whisper 설정 → Python 경로에 mlx-whisper가 설치된 인터프리터 경로 직접 입력\n   (예: /opt/homebrew/bin/python3 또는 가상환경 경로)".to_string()
            })?,
    };
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

        // 청크 1개 전사 한계 — 청크는 보통 30-60초 오디오라 mlx-whisper가 수분 안에 처리.
        // 15분 넘으면 Python 측 hang으로 판단 → 자식 프로세스 SIGKILL 후 서버 핸들 reset.
        let result = guard
            .as_mut()
            .unwrap()
            .transcribe(
                &audio_path,
                &prompt,
                diarize,
                &hf_token,
                std::time::Duration::from_secs(900),
            )
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

#[derive(serde::Serialize)]
struct ClaudeAuthStatus {
    authenticated: bool,
    error: Option<String>,
}

/// Claude CLI 로그인 상태 확인. `claude --print "ok"` 짧은 호출로
/// 실제 인증 토큰 유효성 검증. `--version`은 토큰 없어도 동작하므로 별도 체크 필요.
#[tauri::command]
async fn check_claude_auth(claude_path: Option<String>) -> ClaudeAuthStatus {
    use tokio::io::AsyncWriteExt;
    let bin = claude_path.unwrap_or_else(|| "claude".to_string());

    let mut child = match tokio::process::Command::new(&bin)
        .args(["--print", "--output-format", "json"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            return ClaudeAuthStatus {
                authenticated: false,
                error: Some(format!("Claude CLI 실행 실패: {e}")),
            };
        }
    };

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(b"ok").await;
        let _ = stdin.shutdown().await;
    }

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        child.wait_with_output(),
    )
    .await;

    match result {
        Ok(Ok(output)) if output.status.success() => ClaudeAuthStatus {
            authenticated: true,
            error: None,
        },
        Ok(Ok(output)) => {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let combined = format!("{stderr}\n{stdout}").to_lowercase();
            let auth_keywords = [
                "login", "unauthorized", "invalid api key", "not authenticated",
                "please run", "authentication", "credentials",
            ];
            let is_auth_err = auth_keywords.iter().any(|k| combined.contains(k));
            ClaudeAuthStatus {
                authenticated: false,
                error: Some(if is_auth_err {
                    "Claude CLI 로그인이 필요합니다. 설정 → 'Claude 로그인' 버튼을 눌러주세요.".to_string()
                } else {
                    let msg = stderr.trim();
                    if msg.is_empty() { "Claude CLI 응답 실패".to_string() } else { msg.to_string() }
                }),
            }
        }
        Ok(Err(e)) => ClaudeAuthStatus {
            authenticated: false,
            error: Some(format!("Claude CLI 실행 오류: {e}")),
        },
        Err(_) => ClaudeAuthStatus {
            authenticated: false,
            error: Some("Claude CLI 응답 시간 초과 (20초)".to_string()),
        },
    }
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
/// 빌드된 앱: 리소스 디렉터리에 동봉된 .venv 우선. 개발 환경: cwd 기준 .venv도 시도.
/// 둘 다 실패 시 시스템/홈브루 python3.
#[tauri::command]
async fn auto_detect_python_path(app: tauri::AppHandle) -> Option<String> {
    use tauri::Manager;

    let mut candidates: Vec<String> = Vec::new();
    // 1. 앱 리소스 디렉터리에 동봉된 .venv (정식 빌드)
    if let Ok(resource) = app.path().resource_dir() {
        candidates.push(
            resource.join(".venv").join("bin").join("python").to_string_lossy().into_owned(),
        );
    }
    // 2. 개발 빌드 시 cwd 기준 .venv (cargo run 또는 npm run tauri dev)
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(
            cwd.join(".venv").join("bin").join("python").to_string_lossy().into_owned(),
        );
        // tauri dev는 src-tauri를 cwd로 잡을 수 있어서 한 단계 위도 시도
        if let Some(parent) = cwd.parent() {
            candidates.push(
                parent.join(".venv").join("bin").join("python").to_string_lossy().into_owned(),
            );
        }
    }
    // 3. 시스템/패키지 매니저
    candidates.extend([
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
fn delete_audio_file(
    audio_path: String,
    recordings_path: Option<String>,
) -> Result<(), String> {
    // 임의 경로 삭제 방지 — 청크 임시 디렉터리(notetaker_chunks), 기본 녹음 디렉터리,
    // 또는 사용자가 설정에서 지정한 recordings_path 안의 파일만 허용.
    // canonicalize로 심볼릭 링크/`..` 우회 차단.
    let target = std::path::Path::new(&audio_path);

    // 1) 원본 경로 메타데이터 — 심볼릭 링크 직접 거부 (symlink_metadata는 link 자체 정보).
    //    "이미 없음" 케이스(중복 삭제 요청)는 정상 처리.
    let symlink_meta = match std::fs::symlink_metadata(target) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("경로 조회 실패: {e}")),
    };
    if symlink_meta.file_type().is_symlink() {
        return Err(format!(
            "심볼릭 링크는 삭제 대상이 될 수 없습니다: {}",
            target.display()
        ));
    }

    let canonical = std::fs::canonicalize(target)
        .map_err(|e| format!("경로 정규화 실패: {e}"))?;

    let mut allowed_roots: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(tmp) = std::fs::canonicalize(std::env::temp_dir().join("notetaker_chunks")) {
        allowed_roots.push(tmp);
    }
    if let Some(home) = dirs::home_dir() {
        if let Ok(rec) = std::fs::canonicalize(home.join("Documents").join("Notetaker")) {
            allowed_roots.push(rec);
        }
    }
    // 사용자가 설정한 recordings_path도 허용 (기본값과 다를 수 있음).
    if let Some(rp) = recordings_path.as_deref().filter(|s| !s.is_empty()) {
        if let Ok(rp_canon) = std::fs::canonicalize(rp) {
            allowed_roots.push(rp_canon);
        }
    }

    let allowed = allowed_roots.iter().any(|root| canonical.starts_with(root));
    if !allowed {
        return Err(format!(
            "허용되지 않은 경로의 파일은 삭제할 수 없습니다: {}",
            canonical.display()
        ));
    }

    // 2) TOCTOU 완화: canonicalize 이후 다시 symlink_metadata를 잡아서
    //    검증 ↔ 삭제 사이에 일반 파일이 심볼릭 링크로 바뀌었는지 확인.
    //    바뀌었으면 거부. (완벽한 원자성은 아니지만 공격 윈도우를 최소화.)
    let final_meta = std::fs::symlink_metadata(&canonical)
        .map_err(|e| format!("최종 검증 실패: {e}"))?;
    if !final_meta.file_type().is_file() {
        return Err(format!(
            "일반 파일만 삭제할 수 있습니다: {}",
            canonical.display()
        ));
    }

    std::fs::remove_file(&canonical).map_err(|e| e.to_string())?;
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
    // --max-turns 1: 요약은 단일 응답이면 충분. agentic loop(툴 호출/서브에이전트)로 시간 늘어나는 것 방지.
    cmd.args(["--print", "--output-format", "json", "--max-turns", "1"]);
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

    // 10분 타임아웃: 100k 토큰 가까운 긴 전사 + Sonnet 응답에 5분이 빠듯한 경우 있음.
    // --max-turns 1을 강제했으므로 실제 호출은 한 번뿐이고, 여기서 10분을 넘으면 진짜 문제 상황.
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(600),
        child.wait_with_output(),
    )
    .await
    .map_err(|_| "요약 시간 초과 (10분). Claude CLI가 응답하지 않습니다. 인터넷 연결과 Claude 로그인 상태를 확인하세요.".to_string())?
    .map_err(|e| format!("Claude 응답 대기 실패: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let combined = format!("{stderr}\n{stdout}").to_lowercase();
        let auth_keywords = [
            "login", "unauthorized", "invalid api key", "not authenticated",
            "please run", "authentication", "credentials",
        ];
        if auth_keywords.iter().any(|k| combined.contains(k)) {
            return Err("Claude CLI 로그인이 필요합니다. 설정 → 'Claude 로그인' 버튼을 눌러주세요.".to_string());
        }
        return Err(format!("Claude 오류: {}", if stderr.trim().is_empty() { "응답 없음" } else { stderr.trim() }));
    }

    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// 터미널을 열어 `claude login`을 실행하여 OAuth 플로우를 시작.
/// macOS 전용. Terminal.app에서 사용자가 브라우저로 인증을 완료할 수 있도록 함.
///
/// 보안: AppleScript `do script` 인자는 결국 Terminal.app의 셸로 들어가므로
/// backtick($)/세미콜론 등 메타문자가 그대로 평가됨. claude_path는 사용자 설정에서
/// 오지만 defense-in-depth로 canonicalize + 메타문자 거부.
#[tauri::command]
fn claude_login(claude_path: Option<String>) -> Result<(), String> {
    let bin = claude_path.unwrap_or_else(|| "claude".to_string());

    // 1) 경로 정규화: relative/symlink 제거. 존재하지 않으면 즉시 거부.
    //    "claude" 같은 PATH 단축 이름은 canonicalize 실패 → 명시적 절대 경로 요구.
    let canonical = std::fs::canonicalize(&bin)
        .map_err(|_| format!(
            "Claude CLI 경로를 찾을 수 없습니다: {bin}\n설정 → AI 설정에서 'which claude' 결과의 절대 경로를 입력하세요."
        ))?;

    let path_str = canonical.to_string_lossy();

    // 2) 셸 메타문자 거부: 공백 외의 위험 문자가 있으면 인증 명령 실행 거부.
    //    정상적인 Unix 실행 경로(/opt/homebrew/bin/claude 등)에는 절대 없음.
    const FORBIDDEN: &[char] = &[
        '`', '$', ';', '|', '&', '\n', '\r', '<', '>', '(', ')', '{', '}', '"', '\'', '\\',
    ];
    if path_str.chars().any(|c| FORBIDDEN.contains(&c)) {
        return Err(format!(
            "Claude CLI 경로에 허용되지 않는 문자가 포함돼 있습니다: {path_str}"
        ));
    }

    // 3) 실행 가능 비트 확인 — 잘못된 경로(예: 디렉터리)면 사전 거부.
    use std::os::unix::fs::PermissionsExt;
    let metadata = std::fs::metadata(&canonical)
        .map_err(|e| format!("Claude CLI 메타데이터 조회 실패: {e}"))?;
    if !metadata.is_file() || metadata.permissions().mode() & 0o111 == 0 {
        return Err(format!("Claude CLI 경로가 실행 파일이 아닙니다: {path_str}"));
    }

    let script = format!(
        "tell application \"Terminal\"\nactivate\ndo script \"{path_str} login\"\nend tell"
    );
    std::process::Command::new("osascript")
        .args(["-e", &script])
        .status()
        .map_err(|e| format!("Terminal 실행 실패: {e}"))?;
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
            check_claude_auth,
            claude_login,
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
