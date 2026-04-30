use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::path::PathBuf;
use std::time::{Duration, Instant};
use anyhow::Result;
use chrono::Local;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use hound::{WavSpec, WavWriter, SampleFormat};

#[cfg(target_os = "macos")]
use crate::sck_capture::{self, SckCapture, SAMPLE_RATE as SCK_SAMPLE_RATE};

const CHUNK_SAMPLES: usize = 60 * 16_000;   // 60초
const OVERLAP_SAMPLES: usize = 2 * 16_000;  // 청크 간 2초 오버랩 (경계 단어 잘림 방지)
const MIN_FINAL_SAMPLES: usize = 16_000 / 2; // 최소 0.5초 이상일 때만 final chunk 저장
const LEVEL_EMIT_INTERVAL: Duration = Duration::from_millis(100);
const MAX_RECORDING_DURATION: Duration = Duration::from_secs(3 * 60 * 60);
// VAD 임계값. RMS가 이 값보다 낮으면 무음으로 간주 → Whisper 호출 생략.
// 일반 회의 대화는 0.02~0.1 수준, 잡음/공조 소음은 보통 0.005 이하.
const VAD_RMS_THRESHOLD: f32 = 0.005;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AudioDevice {
    pub name: String,
    pub is_default: bool,
    pub is_blackhole: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RecordingResult {
    pub audio_path: String,
    pub duration_sec: u64,
    pub total_chunks: u32,
}

pub struct RecordingState {
    pub is_recording: Arc<AtomicBool>,
    pub is_paused: Arc<AtomicBool>,
    pub start_time: Arc<Mutex<Option<Instant>>>,
    pub target_sample_rate: u32,
    pub output_path: Arc<Mutex<Option<PathBuf>>>,
    pub stream: Mutex<Option<cpal::Stream>>,
    #[cfg(target_os = "macos")]
    pub sck: Mutex<Option<SckCapture>>,
    pub chunk_index: Arc<AtomicU32>,
    pub chunks_dir: Arc<Mutex<Option<PathBuf>>>,
    // 처리 스레드가 소유하는 WAV writer/chunk buffer의 완료를 기다리기 위한 핸들
    pub processor_handle: Mutex<Option<std::thread::JoinHandle<()>>>,
    // 처리 스레드에 데이터를 보내는 sender (녹음 시작 시 생성)
    pub audio_sender: Mutex<Option<mpsc::Sender<Vec<f32>>>>,
    // 일시정지 시간 추적 (duration_sec에서 제외하기 위함)
    pub pause_start_time: Arc<Mutex<Option<Instant>>>,
    pub paused_duration_ms: Arc<AtomicU64>,
}

// cpal::Stream is not Send on macOS but we manage its lifetime carefully
unsafe impl Send for RecordingState {}
unsafe impl Sync for RecordingState {}

impl Default for RecordingState {
    fn default() -> Self {
        Self {
            is_recording: Arc::new(AtomicBool::new(false)),
            is_paused: Arc::new(AtomicBool::new(false)),
            start_time: Arc::new(Mutex::new(None)),
            target_sample_rate: 16000,
            output_path: Arc::new(Mutex::new(None)),
            stream: Mutex::new(None),
            #[cfg(target_os = "macos")]
            sck: Mutex::new(None),
            chunk_index: Arc::new(AtomicU32::new(0)),
            chunks_dir: Arc::new(Mutex::new(None)),
            processor_handle: Mutex::new(None),
            audio_sender: Mutex::new(None),
            pause_start_time: Arc::new(Mutex::new(None)),
            paused_duration_ms: Arc::new(AtomicU64::new(0)),
        }
    }
}

fn write_chunk_wav(samples: &[f32], path: &PathBuf, sample_rate: u32) -> Result<()> {
    let spec = WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: SampleFormat::Int,
    };
    let mut writer = WavWriter::create(path, spec)?;
    for &s in samples {
        let pcm = (s * i16::MAX as f32).clamp(i16::MIN as f32, i16::MAX as f32) as i16;
        writer.write_sample(pcm)?;
    }
    writer.finalize()?;
    Ok(())
}

fn f32_to_i16(s: f32) -> i16 {
    (s * i16::MAX as f32).clamp(i16::MIN as f32, i16::MAX as f32) as i16
}

fn compute_rms(samples: &[f32]) -> f32 {
    if samples.is_empty() { return 0.0; }
    (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
}

fn resample_linear(input: &[f32], ratio: f64) -> Vec<f32> {
    let output_len = (input.len() as f64 * ratio) as usize;
    let mut output = Vec::with_capacity(output_len);
    for i in 0..output_len {
        let src_idx = i as f64 / ratio;
        let idx0 = src_idx as usize;
        let idx1 = (idx0 + 1).min(input.len().saturating_sub(1));
        let frac = (src_idx - idx0 as f64) as f32;
        output.push(input[idx0] * (1.0 - frac) + input[idx1] * frac);
    }
    output
}

fn downmix_to_mono(data: &[f32], channels: usize) -> Vec<f32> {
    if channels == 1 {
        return data.to_vec();
    }
    data.chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect()
}

pub fn list_audio_devices() -> Result<Vec<AudioDevice>> {
    let host = cpal::default_host();
    let default_device = host.default_input_device();
    let default_name = default_device
        .as_ref()
        .and_then(|d| d.name().ok())
        .unwrap_or_default();

    let devices = host
        .input_devices()?
        .filter_map(|d| {
            let name = d.name().ok()?;
            Some(AudioDevice {
                is_default: name == default_name,
                is_blackhole: name.to_lowercase().contains("blackhole"),
                name,
            })
        })
        .collect();

    Ok(devices)
}

pub fn get_recordings_dir(recordings_path: &str) -> PathBuf {
    if recordings_path.is_empty() {
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/tmp"));
        home.join("Documents").join("Notetaker").join("recordings")
    } else {
        PathBuf::from(recordings_path).join("recordings")
    }
}

/// 녹음 세션 컨텍스트 — prepare_session에서 spawn_processor로 넘기는 자원 묶음.
struct SessionContext {
    output_path: PathBuf,
    chunks_dir: PathBuf,
    sender: mpsc::Sender<Vec<f32>>,
    receiver: mpsc::Receiver<Vec<f32>>,
}

/// 녹음 세션 공통 초기화: 좀비 정리, 출력/청크 경로 준비, 상태 초기화, mpsc 채널 생성.
fn prepare_session(
    state: &Arc<RecordingState>,
    recordings_path: &str,
) -> Result<SessionContext> {
    if state.is_recording.load(Ordering::SeqCst) {
        state.is_recording.store(false, Ordering::SeqCst);
        *state.stream.lock().unwrap() = None;
        #[cfg(target_os = "macos")]
        { *state.sck.lock().unwrap() = None; }
        *state.audio_sender.lock().unwrap() = None;
        if let Some(handle) = state.processor_handle.lock().unwrap().take() {
            let _ = handle.join();
        }
    }

    let recordings_dir = get_recordings_dir(recordings_path);
    std::fs::create_dir_all(&recordings_dir)?;
    let filename = Local::now().format("%Y%m%d_%H%M%S.wav").to_string();
    let output_path = recordings_dir.join(&filename);

    // 청크 임시 파일은 /tmp 세션별 서브디렉터리에 저장. 세션별 분리
    // → 크래시 복구/동시 실행 안전. 시작 시 일괄 삭제 안 함 (이전 세션의
    // 미처리 청크 보존). 개별 청크는 JS에서 전사 후 delete_audio_file로 삭제.
    let session_id = Local::now().format("%Y%m%d_%H%M%S").to_string();
    let chunks_dir = std::env::temp_dir()
        .join("notetaker_chunks")
        .join(&session_id);
    std::fs::create_dir_all(&chunks_dir)?;

    *state.output_path.lock().unwrap() = Some(output_path.clone());
    *state.start_time.lock().unwrap() = Some(Instant::now());
    *state.chunks_dir.lock().unwrap() = Some(chunks_dir.clone());
    state.chunk_index.store(0, Ordering::SeqCst);
    state.is_paused.store(false, Ordering::SeqCst);
    state.paused_duration_ms.store(0, Ordering::SeqCst);
    *state.pause_start_time.lock().unwrap() = None;

    let (tx, rx) = mpsc::channel::<Vec<f32>>();
    *state.audio_sender.lock().unwrap() = Some(tx.clone());

    Ok(SessionContext {
        output_path,
        chunks_dir,
        sender: tx,
        receiver: rx,
    })
}

/// 처리 스레드: PCM Vec<f32>를 받아서 다운믹스/리샘플/WAV 저장/청크 emit.
/// 어떤 캡처 소스(cpal, SCK 등)가 보내든 동일하게 동작한다.
fn spawn_processor(
    state: Arc<RecordingState>,
    app: AppHandle,
    output_path: PathBuf,
    chunks_dir: PathBuf,
    rx: mpsc::Receiver<Vec<f32>>,
    native_sample_rate: u32,
    channels: usize,
) -> std::thread::JoinHandle<()> {
    let target_sample_rate = state.target_sample_rate;
    let is_recording_proc = state.is_recording.clone();
    let chunk_index_proc = state.chunk_index.clone();
    let app_proc = app;

    std::thread::spawn(move || {
        let spec = WavSpec {
            channels: 1,
            sample_rate: target_sample_rate,
            bits_per_sample: 16,
            sample_format: SampleFormat::Int,
        };
        let mut wav_writer = WavWriter::create(&output_path, spec).ok();

        let mut chunk_buffer: Vec<f32> = Vec::new();
        let mut last_level_emit = Instant::now();
        let mut level_accum: Vec<f32> = Vec::new();

        let start = Instant::now();
        let resample_ratio = target_sample_rate as f64 / native_sample_rate as f64;

        while let Ok(raw_samples) = rx.recv() {
            if start.elapsed() >= MAX_RECORDING_DURATION {
                is_recording_proc.store(false, Ordering::SeqCst);
                let _ = app_proc.emit(
                    "recording-auto-stopped",
                    serde_json::json!({"reason": "3시간 최대 녹음 시간 초과"}),
                );
                break;
            }

            let mono = downmix_to_mono(&raw_samples, channels);

            level_accum.extend_from_slice(&mono);
            if last_level_emit.elapsed() >= LEVEL_EMIT_INTERVAL {
                let rms = compute_rms(&level_accum);
                let _ = app_proc.emit("audio-level", serde_json::json!({"rms": rms}));
                level_accum.clear();
                last_level_emit = Instant::now();
            }

            // ratio가 1이면 (이미 16kHz로 들어오는 SCK 경로) 복사만 발생.
            let resampled = if (resample_ratio - 1.0).abs() < f64::EPSILON {
                mono
            } else {
                resample_linear(&mono, resample_ratio)
            };

            if let Some(ref mut writer) = wav_writer {
                for &s in &resampled {
                    let _ = writer.write_sample(f32_to_i16(s));
                }
            }

            chunk_buffer.extend_from_slice(&resampled);
            if chunk_buffer.len() >= CHUNK_SAMPLES {
                let chunk_data: Vec<f32> = chunk_buffer[..CHUNK_SAMPLES].to_vec();
                chunk_buffer.drain(..CHUNK_SAMPLES - OVERLAP_SAMPLES);

                let idx = chunk_index_proc.fetch_add(1, Ordering::SeqCst);
                let chunk_path = chunks_dir.join(format!("chunk_{idx}.wav"));
                // VAD: 청크 전체 RMS가 무음 임계값 이하면 Whisper 안 돌리고
                // 빈 텍스트로 처리. Whisper의 무음 구간 할루시네이션 방지.
                let chunk_rms = compute_rms(&chunk_data);
                let is_silent = chunk_rms < VAD_RMS_THRESHOLD;

                if write_chunk_wav(&chunk_data, &chunk_path, target_sample_rate).is_ok() {
                    let _ = app_proc.emit("chunk-ready", serde_json::json!({
                        "path": chunk_path.to_string_lossy(),
                        "index": idx,
                        "is_final": false,
                        "has_overlap_prefix": idx > 0,
                        "is_silent": is_silent,
                        "rms": chunk_rms,
                    }));
                }
            }
        }

        if chunk_buffer.len() >= MIN_FINAL_SAMPLES {
            let idx = chunk_index_proc.fetch_add(1, Ordering::SeqCst);
            let chunk_path = chunks_dir.join(format!("chunk_{idx}.wav"));
            let chunk_rms = compute_rms(&chunk_buffer);
            let is_silent = chunk_rms < VAD_RMS_THRESHOLD;
            if write_chunk_wav(&chunk_buffer, &chunk_path, target_sample_rate).is_ok() {
                let _ = app_proc.emit("chunk-ready", serde_json::json!({
                    "path": chunk_path.to_string_lossy(),
                    "index": idx,
                    "is_final": true,
                    "has_overlap_prefix": idx > 0,
                    "is_silent": is_silent,
                    "rms": chunk_rms,
                }));
            }
        }

        if let Some(writer) = wav_writer {
            let _ = writer.finalize();
        }
    })
}

/// 마이크만 캡처 (cpal). 기존 동작.
pub fn start_recording(
    state: Arc<RecordingState>,
    app: AppHandle,
    device_name: Option<String>,
    recordings_path: String,
) -> Result<()> {
    let SessionContext { output_path, chunks_dir, sender: tx, receiver: rx } =
        prepare_session(&state, &recordings_path)?;

    let host = cpal::default_host();
    let device = if let Some(ref name) = device_name {
        host.input_devices()?
            .find(|d| d.name().map(|n| n == *name).unwrap_or(false))
            .ok_or_else(|| anyhow::anyhow!("디바이스를 찾을 수 없습니다: {name}"))?
    } else {
        host.default_input_device()
            .ok_or_else(|| anyhow::anyhow!("기본 마이크를 찾을 수 없습니다."))?
    };

    let config = device.default_input_config()?;
    let native_sample_rate = config.sample_rate().0;
    let channels = config.channels() as usize;

    let processor = spawn_processor(
        state.clone(), app.clone(), output_path, chunks_dir, rx,
        native_sample_rate, channels,
    );
    *state.processor_handle.lock().unwrap() = Some(processor);

    let is_recording_cb = state.is_recording.clone();
    let is_paused_cb = state.is_paused.clone();

    let stream = device.build_input_stream(
        &config.config(),
        move |data: &[f32], _| {
            if !is_recording_cb.load(Ordering::SeqCst) || is_paused_cb.load(Ordering::SeqCst) {
                return;
            }
            let _ = tx.send(data.to_vec());
        },
        |err| eprintln!("오디오 스트림 오류: {err}"),
        None,
    )?;

    // is_recording을 먼저 true로 세트한 뒤 스트림 재생 → 첫 콜백 샘플 유실 방지.
    state.is_recording.store(true, Ordering::SeqCst);
    stream.play()?;
    *state.stream.lock().unwrap() = Some(stream);

    Ok(())
}

/// 시스템 오디오 + 마이크 캡처 (macOS ScreenCaptureKit 기반).
/// BlackHole 같은 가상 드라이버 불필요. 첫 호출 시 화면 녹화 권한 프롬프트.
#[cfg(target_os = "macos")]
pub fn start_recording_system_audio(
    state: Arc<RecordingState>,
    app: AppHandle,
    recordings_path: String,
    capture_mic: bool,
) -> Result<()> {
    if !sck_capture::check_permission() {
        // 시스템 프롬프트 트리거 — 첫 호출은 false 반환할 수 있음.
        sck_capture::request_permission();
        return Err(anyhow::anyhow!(
            "화면 녹화 권한이 필요합니다. 시스템 설정 → 개인정보 보호 및 보안 → 화면 녹화에서 ttiro를 허용한 뒤 앱을 재시작해주세요."
        ));
    }

    let SessionContext { output_path, chunks_dir, sender: tx, receiver: rx } =
        prepare_session(&state, &recordings_path)?;

    let processor = spawn_processor(
        state.clone(), app.clone(), output_path, chunks_dir, rx,
        SCK_SAMPLE_RATE, 1,
    );
    *state.processor_handle.lock().unwrap() = Some(processor);

    // SCK 콜백은 mpsc::Sender<Vec<f32>>로 직접 보낸다. pause 처리를 위해
    // 한 단계 bridge 스레드를 두고 is_paused일 때만 drop. 종료는 SckCapture
    // drop → Swift stop → bridge_tx drop → bridge_rx 닫힘으로 자연스레 처리.
    let is_paused = state.is_paused.clone();
    let (bridge_tx, bridge_rx) = mpsc::channel::<Vec<f32>>();
    std::thread::spawn(move || {
        while let Ok(samples) = bridge_rx.recv() {
            if is_paused.load(Ordering::SeqCst) { continue; }
            if tx.send(samples).is_err() { break; }
        }
    });

    // is_recording을 먼저 true로 세트한 뒤 캡처 시작 → 첫 샘플 유실 최소화.
    state.is_recording.store(true, Ordering::SeqCst);
    let sck = match SckCapture::start(bridge_tx, capture_mic) {
        Ok(s) => s,
        Err(e) => {
            state.is_recording.store(false, Ordering::SeqCst);
            *state.audio_sender.lock().unwrap() = None;
            return Err(e);
        }
    };
    *state.sck.lock().unwrap() = Some(sck);

    Ok(())
}

#[cfg(target_os = "macos")]
pub fn check_screen_recording_permission() -> bool {
    sck_capture::check_permission()
}

#[cfg(target_os = "macos")]
pub fn request_screen_recording_permission() -> bool {
    sck_capture::request_permission()
}

pub fn stop_recording(state: Arc<RecordingState>, _app: AppHandle) -> Result<RecordingResult> {
    if !state.is_recording.load(Ordering::SeqCst) {
        return Err(anyhow::anyhow!("녹음 중이 아닙니다."));
    }

    // 1. 녹음 중지 플래그
    state.is_recording.store(false, Ordering::SeqCst);

    // 2. 오디오 스트림 드랍 → 콜백 중지 → sender도 드랍
    *state.stream.lock().unwrap() = None;
    #[cfg(target_os = "macos")]
    { *state.sck.lock().unwrap() = None; }
    *state.audio_sender.lock().unwrap() = None;

    // 3. 처리 스레드 완료 대기 (WAV finalize + final chunk 저장)
    if let Some(handle) = state.processor_handle.lock().unwrap().take() {
        let _ = handle.join();
    }

    let total_chunks = state.chunk_index.load(Ordering::SeqCst);

    // 일시정지 중에 stop한 경우, 현재 pause 시간도 누적
    if state.is_paused.load(Ordering::SeqCst) {
        if let Some(pause_start) = state.pause_start_time.lock().unwrap().take() {
            state.paused_duration_ms.fetch_add(pause_start.elapsed().as_millis() as u64, Ordering::SeqCst);
        }
    }

    let duration_sec = {
        let start = state.start_time.lock().unwrap();
        let total_elapsed = start.map(|s| s.elapsed().as_secs()).unwrap_or(0);
        let paused_secs = state.paused_duration_ms.load(Ordering::SeqCst) / 1000;
        total_elapsed.saturating_sub(paused_secs)
    };

    let audio_path = {
        let path = state.output_path.lock().unwrap();
        path.as_ref()
            .map(|p| p.to_string_lossy().to_string())
            .ok_or_else(|| anyhow::anyhow!("녹음 파일 경로를 찾을 수 없습니다."))?
    };

    Ok(RecordingResult {
        audio_path,
        duration_sec,
        total_chunks,
    })
}

pub fn pause_recording(state: Arc<RecordingState>) -> Result<()> {
    if !state.is_recording.load(Ordering::SeqCst) {
        return Err(anyhow::anyhow!("녹음 중이 아닙니다."));
    }
    state.is_paused.store(true, Ordering::SeqCst);
    *state.pause_start_time.lock().unwrap() = Some(Instant::now());
    Ok(())
}

pub fn resume_recording(state: Arc<RecordingState>) -> Result<()> {
    if !state.is_recording.load(Ordering::SeqCst) {
        return Err(anyhow::anyhow!("녹음 중이 아닙니다."));
    }
    // 일시정지 시간 누적
    if let Some(pause_start) = state.pause_start_time.lock().unwrap().take() {
        state.paused_duration_ms.fetch_add(pause_start.elapsed().as_millis() as u64, Ordering::SeqCst);
    }
    state.is_paused.store(false, Ordering::SeqCst);
    Ok(())
}
