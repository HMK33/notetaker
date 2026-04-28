use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
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

    pub fn transcribe(
        &mut self,
        audio_path: &str,
        initial_prompt: &str,
        diarize: bool,
        hf_token: &str,
    ) -> Result<TranscriptResult> {
        let req = serde_json::json!({
            "audio_path": audio_path,
            "initial_prompt": initial_prompt,
            "diarize": diarize,
            "hf_token": hf_token,
        });

        writeln!(self.stdin, "{req}").map_err(|e| anyhow::anyhow!("stdin 쓰기 실패: {e}"))?;
        self.stdin.flush().map_err(|e| anyhow::anyhow!("stdin flush 실패: {e}"))?;

        let mut response = String::new();
        let bytes_read = self
            .stdout
            .read_line(&mut response)
            .map_err(|e| anyhow::anyhow!("stdout 읽기 실패: {e}"))?;

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
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
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
            PythonEnvStatus {
                installed: false,
                python_path: python_path.to_string(),
                error: Some(stderr),
            }
        }
        Err(e) => PythonEnvStatus {
            installed: false,
            python_path: python_path.to_string(),
            error: Some(e.to_string()),
        },
    }
}
