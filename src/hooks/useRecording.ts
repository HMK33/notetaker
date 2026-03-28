import { useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { v4 as uuidv4 } from "uuid";
import { useMeetingStore } from "../store/meetingStore";
import { summarizeMeeting } from "../services/llm";
import { saveMeeting, updateMeetingTranscript, updateMeetingSummary } from "../services/database";
import type { RecordingResult, TranscriptResult, Meeting, AppSettings } from "../types";

/**
 * 오버랩 청크 간 중복 텍스트를 제거하고 합침 (rust 측 오버랩 제거로 단순 병합 사용)
 */
function mergeOverlappingChunks(chunks: string[]): string {
  if (chunks.length === 0) return "";
  let result = chunks[0].trim();

  for (let i = 1; i < chunks.length; i++) {
    const next = chunks[i].trim();
    if (!next) continue;
    result += (result ? " " : "") + next;
  }

  return result.replace(/\s+/g, " ").trim();
}

export function useRecording(geminiApiKey: string, settings?: AppSettings) {
  const {
    setRecordingState,
    setProcessingStep,
    setAudioLevel,
    setCurrentMeeting,
    updateCurrentMeeting,
    addMeeting,
    setError,
  } = useMeetingStore();

  const unlistenFns = useRef<Array<() => void>>([]);

  // 청크 전사 조립 상태
  const chunkTranscripts = useRef<Map<number, string>>(new Map());
  const totalChunksRef = useRef<number | null>(null);
  const meetingIdRef = useRef<string | null>(null);
  const memoRef = useRef<string | null>(null);
  const assembleResolveRef = useRef<((text: string) => void) | null>(null);

  // Whisper 큐: 동시 실행 1개 제한
  const chunkQueue = useRef<Array<{ path: string; index: number }>>([]);
  const isProcessingChunk = useRef(false);
  // 이전 청크 마지막 문장 (다음 청크의 initial_prompt로 사용)
  const prevChunkTailRef = useRef<string>("");
  // settings를 ref로 감싸서 이벤트 리스너 effect가 settings 변경 시 재등록되지 않도록 함
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const tryAssemble = useCallback(() => {
    const total = totalChunksRef.current;
    if (total === null || assembleResolveRef.current === null) return;

    const map = chunkTranscripts.current;
    for (let i = 0; i < total; i++) {
      if (!map.has(i)) return; // 아직 안 된 청크 있음
    }

    // 모든 청크 완료 → 오버랩 중복 제거 후 합치기
    const chunks = Array.from({ length: total }, (_, i) => map.get(i)!);
    const fullText = mergeOverlappingChunks(chunks);

    assembleResolveRef.current(fullText);
    assembleResolveRef.current = null;
  }, []);

  const waitForAssembly = useCallback((): Promise<string> => {
    return new Promise((resolve) => {
      assembleResolveRef.current = resolve;
      // 혹시 이미 모두 완료된 경우를 위해 즉시 체크
      tryAssemble();
    });
  }, [tryAssemble]);

  const processNextChunk = useCallback(async () => {
    if (isProcessingChunk.current || chunkQueue.current.length === 0) return;
    isProcessingChunk.current = true;
    const { path, index } = chunkQueue.current.shift()!;
    // initial_prompt: 메모 + 이전 청크 마지막 ~150자
    const memoHint = memoRef.current ? `회의 주제: ${memoRef.current}. ` : "";
    const initialPrompt = (memoHint + prevChunkTailRef.current).trim();

    try {
      const result = await invoke<TranscriptResult>("run_whisper", {
        audioPath: path,
        pythonPath: settingsRef.current?.python_path,
        model: settingsRef.current?.whisper_model,
        initialPrompt: initialPrompt || undefined,
      });
      const text = result.text.trim();
      chunkTranscripts.current.set(index, text);
      // 다음 청크 품질을 위해 현재 청크 끝 ~150자 보존
      prevChunkTailRef.current = text.slice(-150);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[Whisper] 청크 ${index} 전사 실패:`, msg);
      chunkTranscripts.current.set(index, "");
      // 사용자에게 부분 전사 실패 알림
      setError(`일부 구간(${index + 1}번) 전사 실패 — 해당 구간은 비어있습니다.`);
    } finally {
      invoke("delete_audio_file", { audioPath: path }).catch(() => {});
      tryAssemble();
      isProcessingChunk.current = false;
      // 큐에 남은 청크가 있으면 다음 처리
      processNextChunk();
    }
  }, [tryAssemble, setError]);

  useEffect(() => {
    // cancelled 플래그: settings 변경 등으로 effect가 재실행될 때
    // 이전 async setupListeners가 완료되더라도 리스너를 등록하지 않도록 방지
    let cancelled = false;

    const setupListeners = async () => {
      const unlisten1 = await listen<{ rms: number }>("audio-level", (e) => {
        setAudioLevel(Math.min(e.payload.rms * 3, 1));
      });

      const unlisten2 = await listen<{ reason: string }>(
        "recording-auto-stopped",
        () => {
          setRecordingState("idle");
          setError("3시간 최대 녹음 시간에 도달하여 자동 중지되었습니다.");
        }
      );

      // 청크 전사 처리 — 큐 + 동시실행 1개 제한 (RAM 폭주 방지)
      const unlisten3 = await listen<{ path: string; index: number; is_final: boolean }>(
        "chunk-ready",
        (e) => {
          chunkQueue.current.push({ path: e.payload.path, index: e.payload.index });
          processNextChunk();
        }
      );

      // effect가 이미 cleanup됐으면 방금 등록한 리스너를 즉시 해제
      if (cancelled) {
        unlisten1();
        unlisten2();
        unlisten3();
        return;
      }

      unlistenFns.current = [unlisten1, unlisten2, unlisten3];
    };

    setupListeners();

    return () => {
      cancelled = true;
      unlistenFns.current.forEach((fn) => fn());
      unlistenFns.current = [];
    };
  }, [setAudioLevel, setRecordingState, setError, tryAssemble, processNextChunk]);

  const startRecording = useCallback(
    async (deviceName?: string) => {
      try {
        setError(null);
        // 청크 상태 초기화
        chunkTranscripts.current = new Map();
        totalChunksRef.current = null;
        assembleResolveRef.current = null;
        chunkQueue.current = [];
        isProcessingChunk.current = false;
        prevChunkTailRef.current = "";

        // audio_source 설정에 따라 디바이스 자동 선택
        let resolvedDevice = deviceName ?? null;
        if (!resolvedDevice && settingsRef.current?.audio_source === "system_and_mic") {
          try {
            const devices = await invoke<Array<{ name: string; is_blackhole: boolean }>>("list_audio_devices");
            const blackhole = devices.find((d) => d.is_blackhole);
            if (blackhole) {
              resolvedDevice = blackhole.name;
            } else {
              setError("시스템 오디오 녹음을 위해 BlackHole이 필요합니다. 설치 후 다시 시도해주세요.");
              return;
            }
          } catch {
            // 디바이스 목록 조회 실패 시 기본 마이크 사용
          }
        }

        await invoke("start_recording", {
          deviceName: resolvedDevice,
          recordingsPath: settings?.recordings_path ?? null,
        });
        setRecordingState("recording");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(`녹음 시작 실패: ${msg}`);
      }
    },
    [settings, setRecordingState, setError]
  );

  const stopRecording = useCallback(
    async (title: string | null, memo: string | null) => {
      try {
        setRecordingState("processing");
        setProcessingStep("saving");

        // memo를 stop 전에 설정 → 이미 큐에 있는 청크에도 메모 힌트 적용
        memoRef.current = memo;

        // 1. 녹음 중지 (마지막 청크도 emit됨)
        const recordingResult = await invoke<RecordingResult>("stop_recording");
        const meetingId = uuidv4();
        const now = new Date().toISOString();

        meetingIdRef.current = meetingId;

        const initialMeeting: Meeting = {
          id: meetingId,
          title,
          recorded_at: now,
          duration_sec: recordingResult.duration_sec,
          audio_path: recordingResult.audio_path,
          memo,
          transcript: null,
          summary: null,
          notion_page_id: null,
          created_at: now,
        };

        setCurrentMeeting(initialMeeting);

        // 2. 청크 전사 완료 대기 (이미 병렬로 진행 중)
        setProcessingStep("transcribing");
        totalChunksRef.current = recordingResult.total_chunks;

        let fullTranscript: string;
        if (recordingResult.total_chunks === 0) {
          fullTranscript = "";
        } else {
          fullTranscript = await waitForAssembly();
        }

        updateCurrentMeeting({ transcript: fullTranscript });

        // 3. Gemini 요약
        if (geminiApiKey && navigator.onLine && fullTranscript) {
          setProcessingStep("summarizing");
          try {
            const summary = await summarizeMeeting(fullTranscript, memo, geminiApiKey);
            updateCurrentMeeting({ summary });
          } catch (e) {
            console.error("Gemini 요약 실패:", e);
          }
        }

        // 4. SQLite 저장
        const finalMeeting = useMeetingStore.getState().currentMeeting!;
        await saveMeeting(finalMeeting);
        addMeeting(finalMeeting);

        setProcessingStep(null);
        setRecordingState("done");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        setRecordingState("error");
        setProcessingStep(null);
      }
    },
    [
      geminiApiKey,
      setRecordingState,
      setProcessingStep,
      setCurrentMeeting,
      updateCurrentMeeting,
      addMeeting,
      setError,
      waitForAssembly,
    ]
  );

  const retryTranscript = useCallback(
    async (audioPath: string, meetingId: string) => {
      try {
        setProcessingStep("transcribing");
        const result = await invoke<TranscriptResult>("run_whisper", {
          audioPath,
          pythonPath: settings?.python_path,
          model: settings?.whisper_model,
        });
        await updateMeetingTranscript(meetingId, result.text);
        updateCurrentMeeting({ transcript: result.text });
        setProcessingStep(null);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(`전사 재시도 실패: ${msg}`);
        setProcessingStep(null);
      }
    },
    [settings, setProcessingStep, updateCurrentMeeting, setError]
  );

  const retrySummary = useCallback(
    async (transcript: string, memo: string | null, meetingId: string) => {
      try {
        if (!geminiApiKey) {
          setError("Gemini API 키가 설정되지 않았습니다.");
          return;
        }
        setProcessingStep("summarizing");
        const summary = await summarizeMeeting(transcript, memo, geminiApiKey);
        await updateMeetingSummary(meetingId, summary);
        updateCurrentMeeting({ summary });
        setProcessingStep(null);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(`요약 재시도 실패: ${msg}`);
        setProcessingStep(null);
      }
    },
    [geminiApiKey, setProcessingStep, updateCurrentMeeting, setError]
  );

  const pauseRecording = useCallback(async () => {
    try {
      await invoke("pause_recording");
      setRecordingState("paused");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`일시정지 실패: ${msg}`);
    }
  }, [setRecordingState, setError]);

  const resumeRecording = useCallback(async () => {
    try {
      await invoke("resume_recording");
      setRecordingState("recording");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`재개 실패: ${msg}`);
    }
  }, [setRecordingState, setError]);

  return { startRecording, stopRecording, pauseRecording, resumeRecording, retryTranscript, retrySummary };
}
