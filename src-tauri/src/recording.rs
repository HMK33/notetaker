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

const CHUNK_SAMPLES: usize = 60 * 16_000;   // 60초
const MIN_FINAL_SAMPLES: usize = 3 * 16_000; // 최소 3초 이상일 때만 final chunk 저장
const LEVEL_EMIT_INTERVAL: Duration = Duration::from_millis(100);
const MAX_RECORDING_DURATION: Duration = Duration::from_secs(3 * 60 * 60);

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

pub fn start_recording(
    state: Arc<RecordingState>,
    app: AppHandle,
    device_name: Option<String>,
    recordings_path: String,
) -> Result<()> {
    if state.is_recording.load(Ordering::SeqCst) {
        // 기존에 진행 중인 녹음이 있으면 (ex. 새로고침 시 좀비 프로세스) 강제로 중지합니다.
        state.is_recording.store(false, Ordering::SeqCst);
        *state.stream.lock().unwrap() = None;
        *state.audio_sender.lock().unwrap() = None;
        if let Some(handle) = state.processor_handle.lock().unwrap().take() {
            let _ = handle.join();
        }
    }

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
    let target_sample_rate = state.target_sample_rate;

    // 출력 파일 및 청크 디렉터리 준비
    let recordings_dir = get_recordings_dir(&recordings_path);
    std::fs::create_dir_all(&recordings_dir)?;
    let filename = Local::now().format("%Y%m%d_%H%M%S.wav").to_string();
    let output_path = recordings_dir.join(&filename);

    // 청크 임시 파일은 /tmp에 저장 — Python 서브프로세스가 ~/Documents에
    // 접근하려면 별도 TCC 권한이 필요하지만 /tmp는 제한 없음
    let chunks_dir = std::env::temp_dir().join("notetaker_chunks");
    // 이전 녹음의 청크 찌꺼기 정리
    let _ = std::fs::remove_dir_all(&chunks_dir);
    std::fs::create_dir_all(&chunks_dir)?;

    // 상태 초기화
    *state.output_path.lock().unwrap() = Some(output_path.clone());
    *state.start_time.lock().unwrap() = Some(Instant::now());
    *state.chunks_dir.lock().unwrap() = Some(chunks_dir.clone());
    state.chunk_index.store(0, Ordering::SeqCst);
    state.is_paused.store(false, Ordering::SeqCst);
    state.paused_duration_ms.store(0, Ordering::SeqCst);
    *state.pause_start_time.lock().unwrap() = None;

    // mpsc 채널 생성 — 콜백 → 처리 스레드
    let (tx, rx) = mpsc::channel::<Vec<f32>>();
    *state.audio_sender.lock().unwrap() = Some(tx.clone());

    // ── 처리 스레드: 리샘플링, WAV 쓰기, 청크 관리, 이벤트 emit ──
    let is_recording_proc = state.is_recording.clone();
    let chunk_index_proc = state.chunk_index.clone();
    let app_proc = app.clone();

    let processor = std::thread::spawn(move || {
        // WAV writer (이 스레드가 단독 소유)
        let spec = WavSpec {
            channels: 1,
            sample_rate: target_sample_rate,
            bits_per_sample: 16,
            sample_format: SampleFormat::Int,
        };
        let mut wav_writer = WavWriter::create(&output_path, spec).ok();

        // 청크 버퍼 (이 스레드가 단독 소유 — Mutex 불필요)
        let mut chunk_buffer: Vec<f32> = Vec::new();

        // 이벤트 쓰로틀링
        let mut last_level_emit = Instant::now();
        let mut level_accum: Vec<f32> = Vec::new();

        let start = Instant::now();
        let resample_ratio = target_sample_rate as f64 / native_sample_rate as f64;

        while let Ok(raw_samples) = rx.recv() {
            // 3시간 타임아웃
            if start.elapsed() >= MAX_RECORDING_DURATION {
                is_recording_proc.store(false, Ordering::SeqCst);
                let _ = app_proc.emit(
                    "recording-auto-stopped",
                    serde_json::json!({"reason": "3시간 최대 녹음 시간 초과"}),
                );
                break;
            }

            // 1. 다운믹스
            let mono = downmix_to_mono(&raw_samples, channels);

            // 2. 음량 레벨 (100ms 쓰로틀링)
            level_accum.extend_from_slice(&mono);
            if last_level_emit.elapsed() >= LEVEL_EMIT_INTERVAL {
                let rms = compute_rms(&level_accum);
                let _ = app_proc.emit("audio-level", serde_json::json!({"rms": rms}));
                level_accum.clear();
                last_level_emit = Instant::now();
            }

            // 3. 리샘플링
            let resampled = resample_linear(&mono, resample_ratio);

            // 4. WAV 파일 쓰기
            if let Some(ref mut writer) = wav_writer {
                for &s in &resampled {
                    let _ = writer.write_sample(f32_to_i16(s));
                }
            }

            // 5. 청크 관리 (즉시 크기 체크 — 1초 폴링 제거)
            chunk_buffer.extend_from_slice(&resampled);
            if chunk_buffer.len() >= CHUNK_SAMPLES {
                let chunk_data: Vec<f32> = chunk_buffer.drain(..CHUNK_SAMPLES).collect();
                let idx = chunk_index_proc.fetch_add(1, Ordering::SeqCst);
                let chunk_path = chunks_dir.join(format!("chunk_{idx}.wav"));

                if write_chunk_wav(&chunk_data, &chunk_path, target_sample_rate).is_ok() {
                    let _ = app_proc.emit("chunk-ready", serde_json::json!({
                        "path": chunk_path.to_string_lossy(),
                        "index": idx,
                        "is_final": false
                    }));
                }

            }
        }

        // 녹음 종료 후 남은 청크 버퍼 → final chunk
        if chunk_buffer.len() >= MIN_FINAL_SAMPLES {
            let idx = chunk_index_proc.fetch_add(1, Ordering::SeqCst);
            let chunk_path = chunks_dir.join(format!("chunk_{idx}.wav"));
            if write_chunk_wav(&chunk_buffer, &chunk_path, target_sample_rate).is_ok() {
                let _ = app_proc.emit("chunk-ready", serde_json::json!({
                    "path": chunk_path.to_string_lossy(),
                    "index": idx,
                    "is_final": true
                }));
            }
        }

        // WAV writer 마무리
        if let Some(writer) = wav_writer {
            let _ = writer.finalize();
        }
    });

    *state.processor_handle.lock().unwrap() = Some(processor);

    // ── 오디오 콜백: 데이터를 채널로 전달만 (경량) ──
    let is_recording_cb = state.is_recording.clone();
    let is_paused_cb = state.is_paused.clone();

    let stream = device.build_input_stream(
        &config.config(),
        move |data: &[f32], _| {
            if !is_recording_cb.load(Ordering::SeqCst) || is_paused_cb.load(Ordering::SeqCst) {
                return;
            }
            // 콜백은 데이터 복사 + channel send만 수행 (~0.1ms)
            let _ = tx.send(data.to_vec());
        },
        |err| eprintln!("오디오 스트림 오류: {err}"),
        None,
    )?;

    stream.play()?;
    *state.stream.lock().unwrap() = Some(stream);
    state.is_recording.store(true, Ordering::SeqCst);

    Ok(())
}

pub fn stop_recording(state: Arc<RecordingState>, _app: AppHandle) -> Result<RecordingResult> {
    if !state.is_recording.load(Ordering::SeqCst) {
        return Err(anyhow::anyhow!("녹음 중이 아닙니다."));
    }

    // 1. 녹음 중지 플래그
    state.is_recording.store(false, Ordering::SeqCst);

    // 2. 오디오 스트림 드랍 → 콜백 중지 → sender도 드랍
    *state.stream.lock().unwrap() = None;
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
