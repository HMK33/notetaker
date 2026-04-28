//! ScreenCaptureKit-based system audio + microphone capture.
//!
//! Wraps the Swift `AudioCapture` module. Samples arrive on Swift's mixer
//! queue as mono Float32 at 16 kHz and are forwarded to a Rust mpsc channel
//! so the existing recording processor can stay agnostic of the source.

use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;

use anyhow::{anyhow, Result};

#[link(name = "AudioCapture", kind = "static")]
extern "C" {
    fn notetaker_sck_check_permission() -> bool;
    fn notetaker_sck_request_permission() -> bool;
    fn notetaker_sck_start(
        callback: extern "C" fn(*const f32, i32, *mut c_void),
        user_data: *mut c_void,
        capture_mic: bool,
    ) -> i32;
    fn notetaker_sck_stop();
}

pub fn check_permission() -> bool {
    unsafe { notetaker_sck_check_permission() }
}

pub fn request_permission() -> bool {
    unsafe { notetaker_sck_request_permission() }
}

/// 16 kHz mono — same as RecordingState::target_sample_rate.
pub const SAMPLE_RATE: u32 = 16_000;

/// Wrap the mpsc sender in a heap allocation we hand to Swift as user_data.
/// Lives until `stop()` is called and the trampoline stops firing.
struct CallbackCtx {
    sender: mpsc::Sender<Vec<f32>>,
}

extern "C" fn trampoline(samples: *const f32, count: i32, user_data: *mut c_void) {
    if user_data.is_null() || samples.is_null() || count <= 0 {
        return;
    }
    let ctx = unsafe { &*(user_data as *const CallbackCtx) };
    let slice = unsafe { std::slice::from_raw_parts(samples, count as usize) };
    let _ = ctx.sender.send(slice.to_vec());
}

/// Active capture handle. Drop or call `stop()` to tear down.
pub struct SckCapture {
    ctx: *mut CallbackCtx,
    running: AtomicBool,
}

// The raw pointer is owned and synchronized via `running`.
unsafe impl Send for SckCapture {}
unsafe impl Sync for SckCapture {}

impl SckCapture {
    pub fn start(sender: mpsc::Sender<Vec<f32>>, capture_mic: bool) -> Result<Self> {
        let ctx = Box::into_raw(Box::new(CallbackCtx { sender }));
        let rc = unsafe {
            notetaker_sck_start(trampoline, ctx as *mut c_void, capture_mic)
        };
        if rc != 0 {
            // Reclaim the context to avoid leaking when start failed.
            unsafe { drop(Box::from_raw(ctx)); }
            return Err(match rc {
                -1 => anyhow!(
                    "시스템 오디오 캡처 시작 실패. 시스템 설정 > 개인정보 보호 > 화면 녹화에서 Notetaker 권한을 켜주세요."
                ),
                -2 => anyhow!("마이크 캡처 시작 실패. 마이크 권한을 확인해주세요."),
                _ => anyhow!("오디오 캡처 시작 실패 (코드 {rc})"),
            });
        }
        Ok(Self { ctx, running: AtomicBool::new(true) })
    }

    pub fn stop(&self) {
        if self.running.swap(false, Ordering::SeqCst) {
            unsafe { notetaker_sck_stop(); }
            // Swift no longer holds the callback; reclaim the context.
            // Safe because notetaker_sck_stop blocks until streams are torn down.
            unsafe { drop(Box::from_raw(self.ctx)); }
        }
    }
}

impl Drop for SckCapture {
    fn drop(&mut self) {
        self.stop();
    }
}
