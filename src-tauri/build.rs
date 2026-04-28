use std::env;
use std::path::PathBuf;
use std::process::Command;

fn main() {
    if cfg!(target_os = "macos") {
        compile_swift_audio_capture();
    }
    tauri_build::build()
}

fn compile_swift_audio_capture() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let swift_src = manifest_dir.join("swift").join("AudioCapture.swift");
    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let lib_path = out_dir.join("libAudioCapture.a");

    let target = env::var("TARGET").unwrap_or_default();
    // SCStream + capturesAudio는 macOS 13.0+. AVAudioEngine 마이크 캡처는 그 이전부터.
    let target_triple = if target.starts_with("aarch64") {
        "arm64-apple-macosx13.0"
    } else {
        "x86_64-apple-macosx13.0"
    };

    let status = Command::new("swiftc")
        .args(["-emit-library", "-static", "-parse-as-library"])
        .args(["-module-name", "AudioCapture"])
        .args(["-target", target_triple])
        .arg("-O")
        .arg("-o")
        .arg(&lib_path)
        .arg(&swift_src)
        .status()
        .expect("failed to invoke swiftc — install Xcode command line tools");
    assert!(status.success(), "swiftc failed");

    println!("cargo:rustc-link-search=native={}", out_dir.display());
    println!("cargo:rustc-link-lib=static=AudioCapture");

    for fw in [
        "ScreenCaptureKit",
        "CoreMedia",
        "AVFoundation",
        "AudioToolbox",
        "CoreAudio",
        "CoreGraphics",
        "Foundation",
    ] {
        println!("cargo:rustc-link-lib=framework={fw}");
    }

    // Swift runtime libs ship with macOS 10.14.4+
    println!("cargo:rustc-link-search=/usr/lib/swift");
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");

    println!("cargo:rerun-if-changed={}", swift_src.display());
}
