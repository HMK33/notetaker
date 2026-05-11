use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TranscriptSegment {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TranscriptResult {
    pub text: String,
    pub segments: Vec<TranscriptSegment>,
    pub language: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PythonEnvStatus {
    pub installed: bool,
    pub python_path: String,
    pub error: Option<String>,
}

/// 모델을 한 번 로딩 후 stdin/stdout으로 청크를 처리하는 장수(long-running) Python 프로세스.
/// 매 청크마다 새 프로세스를 띄우는 것보다 20-30s → 5-10s 로 전사 속도가 향상됩니다.
pub struct WhisperServer {
    child: Child,
    stdin: std::io::BufWriter<std::process::ChildStdin>,
    stdout: BufReader<std::process::ChildStdout>,
    pub model: String,
    pub python_path: String,
}

impl WhisperServer {
    pub fn start(python_path: &str, script_path: &str, model: &str) -> Result<Self> {
        let mut child = Command::new(python_path)
            .args(["-u", script_path, "--server", model])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| anyhow::anyhow!("Whisper 서버 시작 실패 (python: {python_path}): {e}"))?;

        let stdin = std::io::BufWriter::new(
            child.stdin.take().ok_or_else(|| anyhow::anyhow!("stdin 취득 실패"))?,
        );
        let stdout = BufReader::new(
            child.stdout.take().ok_or_else(|| anyhow::anyhow!("stdout 취득 실패"))?,
        );

        Ok(WhisperServer {
            child,
            stdin,
            stdout,
            model: model.to_string(),
            python_path: python_path.to_string(),
        })
    }

    /// 청크 한 개 전사. Python 응답을 무한 대기하지 않도록 watchdog 스레드로 타임아웃 적용.
    /// 타임아웃 시 자식 프로세스를 SIGKILL → BufReader가 EOF로 unblock → 호출자가 서버 핸들을 reset.
    pub fn transcribe(
        &mut self,
        audio_path: &str,
        initial_prompt: &str,
        diarize: bool,
        hf_token: &str,
        timeout: Duration,
    ) -> Result<TranscriptResult> {
        let req = serde_json::json!({
            "audio_path": audio_path,
            "initial_prompt": initial_prompt,
            "diarize": diarize,
            "hf_token": hf_token,
        });

        writeln!(self.stdin, "{req}").map_err(|e| anyhow::anyhow!("stdin 쓰기 실패: {e}"))?;
        self.stdin.flush().map_err(|e| anyhow::anyhow!("stdin flush 실패: {e}"))?;

        // Watchdog: timeout 동안 자식이 응답 안 하면 SIGKILL.
        // read_line은 blocking I/O라 tokio::timeout으로 풀 수 없음 → 별도 스레드 + kill(2)로 EOF 유도.
        let pid = self.child.id();
        let cancel = Arc::new(AtomicBool::new(false));
        let cancel_clone = Arc::clone(&cancel);
        let watchdog = std::thread::spawn(move || -> bool {
            let start = Instant::now();
            while !cancel_clone.load(Ordering::Relaxed) {
                if start.elapsed() >= timeout {
                    // `kill -9 <pid>` — libc 새 의존성 회피. 자식이 이미 죽었다면 no-op.
                    let _ = Command::new("kill")
                        .args(["-9", &pid.to_string()])
                        .status();
                    return true;
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            false
        });

        let mut response = String::new();
        let read_result = self.stdout.read_line(&mut response);

        cancel.store(true, Ordering::Relaxed);
        let timed_out = watchdog.join().unwrap_or(false);

        if timed_out {
            return Err(anyhow::anyhow!(
                "Whisper 전사 시간 초과 ({}초). 프로세스가 응답하지 않아 강제 종료했습니다.",
                timeout.as_secs()
            ));
        }

        let bytes_read = read_result.map_err(|e| anyhow::anyhow!("stdout 읽기 실패: {e}"))?;

        if bytes_read == 0 {
            return Err(anyhow::anyhow!("Whisper 서버 프로세스가 예기치 않게 종료됨"));
        }

        let value: serde_json::Value = serde_json::from_str(response.trim())
            .map_err(|e| anyhow::anyhow!("결과 파싱 실패: {e}\n출력: {response}"))?;

        if let Some(err) = value.get("error") {
            return Err(anyhow::anyhow!("Whisper 전사 실패: {err}"));
        }

        let result: TranscriptResult = serde_json::from_value(value)
            .map_err(|e| anyhow::anyhow!("결과 역직렬화 실패: {e}"))?;

        Ok(result)
    }
}

impl Drop for WhisperServer {
    /// 앱 종료 시 자식이 SIGKILL에도 즉시 안 죽는 케이스(uninterruptible I/O 등) 방어.
    /// 2초 안에 reap 안 되면 OS에 위임하고 진행 — 앱 종료가 멈춰서 사용자가 강제 종료해야 하는 상황 방지.
    fn drop(&mut self) {
        if let Err(e) = self.child.kill() {
            eprintln!("Whisper 서버 종료 시 kill 실패 (이미 종료됐을 수 있음): {e}");
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            match self.child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => {
                    if Instant::now() >= deadline {
                        eprintln!("Whisper 서버 SIGKILL 후 2초 내 종료 안 됨, OS reap에 위임");
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(_) => return,
            }
        }
    }
}

pub async fn check_python_env(
    app: &AppHandle,
    python_path: &str,
) -> PythonEnvStatus {
    let test_code = "import mlx_whisper; print('ok')";
    let result = app
        .shell()
        .command(python_path)
        .args(["-c", test_code])
        .output()
        .await;

    match result {
        Ok(output) if output.status.success() => PythonEnvStatus {
            installed: true,
            python_path: python_path.to_string(),
            error: None,
        },
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            let lower = stderr.to_lowercase();
            // mlx_whisper / pyannote 미설치는 흔한 케이스 → 설치 명령 안내까지 친절하게.
            let friendly = if lower.contains("no module named 'mlx_whisper'")
                || lower.contains("no module named \"mlx_whisper\"")
                || lower.contains("modulenotfounderror") && lower.contains("mlx")
            {
                format!(
                    "mlx-whisper 패키지가 설치돼 있지 않습니다 ({python_path}).\n\n해결: 터미널에서\n  {python_path} -m pip install mlx-whisper\n\nApple Silicon Mac이 아니면 mlx-whisper는 작동하지 않습니다."
                )
            } else if lower.contains("modulenotfounderror") {
                format!(
                    "Python 모듈 누락 ({python_path}).\n\n원본 메시지:\n{stderr}\n\n해결: 필요한 패키지를 설치하거나 다른 Python 경로를 설정에서 지정해주세요."
                )
            } else {
                stderr
            };
            PythonEnvStatus {
                installed: false,
                python_path: python_path.to_string(),
                error: Some(friendly),
            }
        }
        Err(e) => {
            let raw = e.to_string();
            let lower = raw.to_lowercase();
            let friendly = if lower.contains("no such file") || lower.contains("not found") {
                format!(
                    "Python 인터프리터를 찾을 수 없습니다: {python_path}\n\n해결:\n1. 설정 → Whisper 설정 에서 올바른 Python 경로 입력\n2. 또는 비워두고 자동 탐색 사용 (mlx-whisper 설치된 환경 자동 감지)"
                )
            } else {
                raw
            };
            PythonEnvStatus {
                installed: false,
                python_path: python_path.to_string(),
                error: Some(friendly),
            }
        }
    }
}
