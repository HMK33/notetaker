import Foundation
import ScreenCaptureKit
import CoreMedia
import CoreAudio
import AVFoundation
import CoreGraphics

// MARK: - Public C ABI
// Rust calls these via FFI. Callback signature:
//   void on_samples(const float *samples, int32_t count, void *user_data)
// Samples are mono Float32 at 16 kHz.

public typealias SampleCallback = @convention(c) (UnsafePointer<Float>?, Int32, UnsafeMutableRawPointer?) -> Void

@_cdecl("notetaker_sck_check_permission")
public func notetaker_sck_check_permission() -> Bool {
    // CGPreflightScreenCaptureAccess does not prompt; safe to call anywhere.
    return CGPreflightScreenCaptureAccess()
}

@_cdecl("notetaker_sck_request_permission")
public func notetaker_sck_request_permission() -> Bool {
    // First call triggers system prompt; subsequent calls return current state.
    return CGRequestScreenCaptureAccess()
}

@_cdecl("notetaker_sck_start")
public func notetaker_sck_start(
    callback: SampleCallback,
    userData: UnsafeMutableRawPointer?,
    captureMic: Bool
) -> Int32 {
    return CaptureSession.shared.start(
        callback: callback,
        userData: userData,
        captureMic: captureMic
    )
}

@_cdecl("notetaker_sck_stop")
public func notetaker_sck_stop() {
    CaptureSession.shared.stop()
}

// MARK: - Session singleton

final class CaptureSession {
    static let shared = CaptureSession()

    private let lock = NSLock()
    private var systemCapture: SystemAudioCapture?
    private var micCapture: MicCapture?
    private var mixer: TimedMixer?
    private var running = false

    func start(
        callback: @escaping SampleCallback,
        userData: UnsafeMutableRawPointer?,
        captureMic: Bool
    ) -> Int32 {
        lock.lock(); defer { lock.unlock() }
        if running { return 0 }

        let mixer = TimedMixer(captureMic: captureMic) { ptr, count in
            callback(ptr, count, userData)
        }

        let sys = SystemAudioCapture(mixer: mixer)
        let mic: MicCapture? = captureMic ? MicCapture(mixer: mixer) : nil

        // Start mic first (synchronous) so we don't drop early system audio
        // before mic comes online; mixer waits for both buffers anyway.
        if let mic = mic {
            do { try mic.start() } catch {
                NSLog("[Notetaker] mic start failed: \(error)")
                return -2
            }
        }

        // System audio capture is async (SCStream APIs are async).
        let semaphore = DispatchSemaphore(value: 0)
        var sysError: Error?
        Task {
            do { try await sys.start() } catch { sysError = error }
            semaphore.signal()
        }
        semaphore.wait()
        if let err = sysError {
            NSLog("[Notetaker] system audio start failed: \(err)")
            mic?.stop()
            return -1
        }

        self.systemCapture = sys
        self.micCapture = mic
        self.mixer = mixer
        self.running = true
        return 0
    }

    func stop() {
        lock.lock()
        let sys = systemCapture
        let mic = micCapture
        systemCapture = nil
        micCapture = nil
        mixer = nil
        running = false
        lock.unlock()

        mic?.stop()
        if let sys = sys {
            let semaphore = DispatchSemaphore(value: 0)
            Task {
                await sys.stop()
                semaphore.signal()
            }
            semaphore.wait()
        }
    }
}

// MARK: - Mixer

final class TimedMixer {
    private var systemBuf: [Float] = []
    private var micBuf: [Float] = []
    private let lock = NSLock()
    private let captureMic: Bool
    private let onSamples: (UnsafePointer<Float>, Int32) -> Void
    // Sum of two near-full-scale signals can clip; 0.7 keeps headroom.
    private let mixGain: Float = 0.7
    // Drop initial samples until both sources are flowing to avoid a
    // long mono prefix (e.g. system before mic device wakes).
    private var systemPrimed = false
    private var micPrimed = false

    init(captureMic: Bool, onSamples: @escaping (UnsafePointer<Float>, Int32) -> Void) {
        self.captureMic = captureMic
        self.onSamples = onSamples
        if !captureMic { micPrimed = true }
    }

    func pushSystem(_ samples: [Float]) {
        guard !samples.isEmpty else { return }
        lock.lock(); defer { lock.unlock() }
        systemPrimed = true
        if !micPrimed {
            // Discard early system samples; mic not yet primed.
            return
        }
        systemBuf.append(contentsOf: samples)
        flushLocked()
    }

    func pushMic(_ samples: [Float]) {
        guard !samples.isEmpty else { return }
        lock.lock(); defer { lock.unlock() }
        micPrimed = true
        if !systemPrimed {
            return
        }
        micBuf.append(contentsOf: samples)
        flushLocked()
    }

    private func flushLocked() {
        let n: Int = captureMic
            ? min(systemBuf.count, micBuf.count)
            : systemBuf.count
        guard n > 0 else { return }

        var mixed = [Float](repeating: 0, count: n)
        if captureMic {
            for i in 0..<n {
                let s = (systemBuf[i] + micBuf[i]) * mixGain
                mixed[i] = max(-1.0, min(1.0, s))
            }
            systemBuf.removeFirst(n)
            micBuf.removeFirst(n)
        } else {
            mixed.withUnsafeMutableBufferPointer { dst in
                systemBuf.withUnsafeBufferPointer { src in
                    dst.baseAddress!.update(from: src.baseAddress!, count: n)
                }
            }
            systemBuf.removeFirst(n)
        }
        mixed.withUnsafeBufferPointer { buf in
            onSamples(buf.baseAddress!, Int32(buf.count))
        }
    }
}

// MARK: - System audio capture (SCStream)

final class SystemAudioCapture: NSObject, SCStreamDelegate, SCStreamOutput {
    private var stream: SCStream?
    private let mixer: TimedMixer
    private let queue = DispatchQueue(label: "notetaker.sck.audio", qos: .userInitiated)

    init(mixer: TimedMixer) {
        self.mixer = mixer
    }

    func start() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(
            false, onScreenWindowsOnly: true
        )
        guard let display = content.displays.first else {
            throw NSError(domain: "AudioCapture", code: 10,
                          userInfo: [NSLocalizedDescriptionKey: "No display available"])
        }
        let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.sampleRate = 16_000
        config.channelCount = 1
        // Video capture must be configured but we keep it minimal.
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        config.queueDepth = 5

        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
        try await stream.startCapture()
        self.stream = stream
    }

    func stop() async {
        guard let stream = stream else { return }
        try? await stream.stopCapture()
        self.stream = nil
    }

    // MARK: SCStreamOutput
    func stream(_ stream: SCStream,
                didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
                of outputType: SCStreamOutputType) {
        guard outputType == .audio, sampleBuffer.isValid else { return }
        if let samples = AudioBufferUtils.extractMonoFloat32(from: sampleBuffer) {
            mixer.pushSystem(samples)
        }
    }

    // MARK: SCStreamDelegate
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        NSLog("[Notetaker] SCStream stopped: \(error)")
    }
}

// MARK: - Microphone capture (AVAudioEngine)

final class MicCapture {
    private let engine = AVAudioEngine()
    private var converter: AVAudioConverter?
    private let mixer: TimedMixer
    private let outFormat: AVAudioFormat

    init(mixer: TimedMixer) {
        self.mixer = mixer
        self.outFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: 16_000,
            channels: 1,
            interleaved: false
        )!
    }

    func start() throws {
        let input = engine.inputNode
        let inFormat = input.inputFormat(forBus: 0)
        guard inFormat.sampleRate > 0 else {
            throw NSError(domain: "AudioCapture", code: 20,
                          userInfo: [NSLocalizedDescriptionKey: "No microphone input"])
        }
        guard let converter = AVAudioConverter(from: inFormat, to: outFormat) else {
            throw NSError(domain: "AudioCapture", code: 21,
                          userInfo: [NSLocalizedDescriptionKey: "AVAudioConverter init failed"])
        }
        self.converter = converter

        let outFormat = self.outFormat
        let mixer = self.mixer

        input.installTap(onBus: 0, bufferSize: 4096, format: inFormat) { [weak self] buffer, _ in
            guard let self = self, let converter = self.converter else { return }
            let ratio = outFormat.sampleRate / inFormat.sampleRate
            let outCapacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio + 64)
            guard let outBuf = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: outCapacity) else { return }

            var supplied = false
            var error: NSError?
            let status = converter.convert(to: outBuf, error: &error) { _, statusOut in
                if supplied {
                    statusOut.pointee = .noDataNow
                    return nil
                }
                supplied = true
                statusOut.pointee = .haveData
                return buffer
            }
            if error != nil || status == .error {
                return
            }
            guard let channelData = outBuf.floatChannelData else { return }
            let frames = Int(outBuf.frameLength)
            guard frames > 0 else { return }
            let samples = Array(UnsafeBufferPointer(start: channelData[0], count: frames))
            mixer.pushMic(samples)
        }
        engine.prepare()
        try engine.start()
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
    }
}

// MARK: - CMSampleBuffer → mono Float32 helpers

enum AudioBufferUtils {
    static func extractMonoFloat32(from sampleBuffer: CMSampleBuffer) -> [Float]? {
        guard let formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbdPtr = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc) else {
            return nil
        }
        let asbd = asbdPtr.pointee
        let channels = max(Int(asbd.mChannelsPerFrame), 1)
        let isFloat = (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0
        let isInterleaved = (asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved) == 0

        var blockBuffer: CMBlockBuffer?
        var audioBufferList = AudioBufferList()
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: nil,
            bufferListOut: &audioBufferList,
            bufferListSize: MemoryLayout<AudioBufferList>.size,
            blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil,
            flags: 0,
            blockBufferOut: &blockBuffer
        )
        guard status == noErr else { return nil }
        // Keep blockBuffer alive for the duration of this function.
        _ = blockBuffer

        let bufferList = UnsafeMutableAudioBufferListPointer(&audioBufferList)
        guard isFloat else {
            // SCStream + AVAudioConverter both deliver Float32; bail otherwise.
            return nil
        }

        if isInterleaved {
            guard let abuf = bufferList.first, let raw = abuf.mData else { return nil }
            let totalSamples = Int(abuf.mDataByteSize) / MemoryLayout<Float>.size
            let frames = totalSamples / channels
            let src = raw.assumingMemoryBound(to: Float.self)
            if channels == 1 {
                return Array(UnsafeBufferPointer(start: src, count: frames))
            }
            var mono = [Float](repeating: 0, count: frames)
            let inv = Float(1.0 / Double(channels))
            for i in 0..<frames {
                var sum: Float = 0
                for c in 0..<channels { sum += src[i * channels + c] }
                mono[i] = sum * inv
            }
            return mono
        } else {
            // Non-interleaved: one buffer per channel.
            guard let firstBuf = bufferList.first, let firstData = firstBuf.mData else { return nil }
            let frames = Int(firstBuf.mDataByteSize) / MemoryLayout<Float>.size
            if bufferList.count == 1 {
                let src = firstData.assumingMemoryBound(to: Float.self)
                return Array(UnsafeBufferPointer(start: src, count: frames))
            }
            var mono = [Float](repeating: 0, count: frames)
            let inv = Float(1.0 / Double(bufferList.count))
            for c in 0..<bufferList.count {
                guard let raw = bufferList[c].mData else { continue }
                let src = raw.assumingMemoryBound(to: Float.self)
                for i in 0..<frames { mono[i] += src[i] * inv }
            }
            return mono
        }
    }
}
