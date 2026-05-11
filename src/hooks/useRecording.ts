import { useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { v4 as uuidv4 } from "uuid";
import { useMeetingStore } from "../store/meetingStore";
import { summarizeMeeting, ensureClaudeAuth } from "../services/llm";
import { saveMeeting, updateMeetingTranscript, updateMeetingSummary } from "../services/database";
import type { RecordingResult, TranscriptResult, Meeting, AppSettings, MeetingSetup } from "../types";
import { effectiveHfToken } from "../utils/env";

const ASSEMBLY_TIMEOUT_MS = 60 * 60 * 1000; // 전사 최대 대기 60분

// Whisper의 알려진 환각(hallucination) 패턴.
// 무음/노이즈 구간에서 학습 데이터(유튜브 자막 등)의 정형 문구를 우겨넣는 현상.
// VAD로 1차 차단하고, 그래도 새는 문구는 텍스트 단계에서 제거.
const HALLUCINATION_PATTERNS: RegExp[] = [
  /Jenny[\s,]+Jenny/gi,
  /視聴ありがとうございました/g,
  /ご(?:清|靜|静)聴ありがとうございました/g,
  /字幕\s*by/gi,
  /(?:Subtitles?|Captions?)\s+by\s+\S+/gi,
  /MBC\s*뉴스\s*\S*/g,
  /Thank(?:s| you)\s+for\s+watching/gi,
  /Please\s+subscribe/gi,
  /구독(?:과|,)\s*좋아요/g,
  /다이아몬드에\s*넣어서\s*사용할게요/g,
  /이\s*영상은\s*유익하게\s*보셨다면/g,
];

function cleanHallucinations(text: string): string {
  let cleaned = text;
  for (const pat of HALLUCINATION_PATTERNS) {
    cleaned = cleaned.replace(pat, " ");
  }
  return cleaned.replace(/\s{2,}/g, " ").trim();
}

/**
 * 청크 경계의 오버랩 구간(2초)에서 중복된 텍스트를 제거하고 합침.
 * Rust에서 인접 청크가 마지막/처음 2초를 공유하도록 저장 → 여기서
 * 앞 청크 꼬리와 뒷 청크 머리의 워드 일치 구간을 찾아 뒷 청크에서 절삭.
 * 일치가 없으면 휴리스틱 fallback (예상 오버랩 워드 수만큼 절삭)을 적용.
 */
const OVERLAP_SEC = 2;
const WORDS_PER_SEC_KO = 2.5; // 한국어 대략치 — fallback용

// 단락 구분(\n\n+)을 "단어"로 인코딩해서 dedup이 보존하도록 함.
// 화자 분리 결과가 사라지지 않게 함.
const PARAGRAPH_TOKEN = "§§PARA§§";

function encodeParagraphs(text: string): string {
  return text.replace(/\n{2,}/g, ` ${PARAGRAPH_TOKEN} `);
}

function decodeParagraphs(text: string): string {
  return text
    .replace(new RegExp(`(?:\\s*${PARAGRAPH_TOKEN}\\s*)+`, "g"), "\n\n")
    .trim();
}

function dedupeOverlap(prev: string, curr: string): string {
  if (!prev || !curr) return curr;
  const prevWords = prev.split(/\s+/).filter(Boolean);
  const currWords = curr.split(/\s+/).filter(Boolean);
  // 마지막/처음 최대 40워드 범위에서 가장 긴 완전 일치 찾기
  const maxTry = Math.min(prevWords.length, currWords.length, 40);
  for (let k = maxTry; k >= 3; k--) {
    const prevTail = prevWords.slice(-k).join(" ");
    const currHead = currWords.slice(0, k).join(" ");
    if (prevTail === currHead) {
      return currWords.slice(k).join(" ");
    }
  }
  // Fallback: 일치 실패 시 대략적인 워드 수만큼 절삭 (중복보다는 소실이 요약엔 안전)
  const expected = Math.round(OVERLAP_SEC * WORDS_PER_SEC_KO);
  return currWords.slice(expected).join(" ");
}

function mergeOverlappingChunks(chunks: string[]): string {
  if (chunks.length === 0) return "";
  const encoded = chunks.map((c) => encodeParagraphs(c.trim()));
  let result = encoded[0];

  for (let i = 1; i < encoded.length; i++) {
    const next = dedupeOverlap(result, encoded[i]);
    if (!next) continue;
    result += (result ? " " : "") + next;
  }

  // 모든 공백을 단일 공백으로 정규화한 뒤 단락 토큰만 \n\n으로 복원.
  return decodeParagraphs(result.replace(/[\t ]+/g, " ").trim());
}

export function useRecording(settings?: AppSettings) {
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
  const assembleRejectRef = useRef<((err: Error) => void) | null>(null);
  const assembleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Whisper 큐: 동시 실행 1개 제한
  const chunkQueue = useRef<Array<{ path: string; index: number; isSilent: boolean }>>([]);
  const isProcessingChunk = useRef(false);
  // 이전 청크 마지막 문장 (다음 청크의 initial_prompt로 사용)
  const prevChunkTailRef = useRef<string>("");
  // settings를 ref로 감싸서 이벤트 리스너 effect가 settings 변경 시 재등록되지 않도록 함
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // 미팅 시작 전 사용자가 입력한 메타데이터 (제목/유형/참석자)
  const setupRef = useRef<MeetingSetup | null>(null);

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

    if (assembleTimerRef.current !== null) {
      clearTimeout(assembleTimerRef.current);
      assembleTimerRef.current = null;
    }
    assembleResolveRef.current(fullText);
    assembleResolveRef.current = null;
    assembleRejectRef.current = null;
  }, []);

  const waitForAssembly = useCallback((): Promise<string> => {
    return new Promise((resolve, reject) => {
      assembleResolveRef.current = resolve;
      assembleRejectRef.current = reject;
      assembleTimerRef.current = setTimeout(() => {
        assembleResolveRef.current = null;
        assembleRejectRef.current = null;
        assembleTimerRef.current = null;
        reject(new Error("전사 시간 초과 (5분). Python 프로세스가 응답하지 않습니다."));
      }, ASSEMBLY_TIMEOUT_MS);
      // 혹시 이미 모두 완료된 경우를 위해 즉시 체크
      tryAssemble();
    });
  }, [tryAssemble]);

  const processNextChunk = useCallback(async () => {
    if (isProcessingChunk.current || chunkQueue.current.length === 0) return;
    isProcessingChunk.current = true;
    const { path, index, isSilent } = chunkQueue.current.shift()!;

    // VAD: 무음 청크는 Whisper 호출 생략. 빈 텍스트로 처리.
    if (isSilent) {
      chunkTranscripts.current.set(index, "");
      invoke("delete_audio_file", { audioPath: path }).catch((e) =>
        console.warn(`[chunk] 임시 파일 삭제 실패 (${path}):`, e)
      );
      tryAssemble();
      isProcessingChunk.current = false;
      processNextChunk();
      return;
    }

    // initial_prompt: 메모 + 이전 청크 마지막 ~150자
    const memoHint = memoRef.current ? `회의 주제: ${memoRef.current}. ` : "";
    const initialPrompt = (memoHint + prevChunkTailRef.current).trim();

    // 방어선: 화자 분리 요청됐어도 토큰 없으면 일반 모드로 fallback.
    // (UI에서 비활성화 처리하지만 settings 변경 타이밍 등 race도 방지)
    // 사용자 설정 토큰 → 빌드 시 baked-in env 토큰 순으로 사용.
    const hfToken = effectiveHfToken(settingsRef.current?.hf_token);
    const wantsDiarize = (setupRef.current?.diarize ?? false) && hfToken.length > 0;

    try {
      const result = await invoke<TranscriptResult>("run_whisper", {
        options: {
          audioPath: path,
          pythonPath: settingsRef.current?.python_path,
          model: settingsRef.current?.whisper_model,
          initialPrompt: initialPrompt || undefined,
          diarize: wantsDiarize,
          hfToken: hfToken || undefined,
        },
      });
      const cleaned = cleanHallucinations(result.text);
      chunkTranscripts.current.set(index, cleaned);
      // 다음 청크 품질을 위해 현재 청크 끝 ~150자 보존 (단락 마커 제외하고)
      prevChunkTailRef.current = cleaned.replace(/\n+/g, " ").slice(-150);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[Whisper] 청크 ${index} 전사 실패:`, msg);
      chunkTranscripts.current.set(index, "");
      // 사용자에게 부분 전사 실패 알림
      setError(`일부 구간(${index + 1}번) 전사 실패 — 해당 구간은 비어있습니다.`);
    } finally {
      invoke("delete_audio_file", { audioPath: path }).catch((e) =>
        console.warn(`[chunk] 임시 파일 삭제 실패 (${path}):`, e)
      );
      tryAssemble();
      isProcessingChunk.current = false;
      // 큐에 남은 청크가 있으면 다음 처리
      processNextChunk();
    }
  }, [tryAssemble, setError]);

  // processNextChunk를 ref로 유지하여 listener가 항상 최신 버전을 호출하도록 함
  // settingsRef와 동일한 패턴 — listener useEffect 재실행 없이 stale closure 방지
  const processNextChunkRef = useRef(processNextChunk);
  processNextChunkRef.current = processNextChunk;

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

      const unlistenErr = await listen<{ message: string }>(
        "recording-error",
        (e) => {
          setError(`녹음 오류: ${e.payload.message}`);
        }
      );

      // 청크 전사 처리 — 큐 + 동시실행 1개 제한 (RAM 폭주 방지)
      // processNextChunkRef를 통해 호출 → listener 재등록 없이 항상 최신 함수 참조
      const unlisten3 = await listen<{
        path: string;
        index: number;
        is_final: boolean;
        is_silent?: boolean;
      }>("chunk-ready", (e) => {
        chunkQueue.current.push({
          path: e.payload.path,
          index: e.payload.index,
          isSilent: e.payload.is_silent === true,
        });
        processNextChunkRef.current();
      });

      // effect가 이미 cleanup됐으면 방금 등록한 리스너를 즉시 해제
      if (cancelled) {
        unlisten1();
        unlisten2();
        unlisten3();
        unlistenErr();
        return;
      }

      unlistenFns.current = [unlisten1, unlisten2, unlisten3, unlistenErr];
    };

    setupListeners();

    return () => {
      cancelled = true;
      unlistenFns.current.forEach((fn) => fn());
      unlistenFns.current = [];
    };
  // tryAssemble/processNextChunk를 제거 → 이들이 바뀌어도 listener 재등록 안 함
  // chunk-ready 이벤트 유실 방지 (Tauri 이벤트는 수신자 없으면 drop됨)
  }, [setAudioLevel, setRecordingState, setError]);

  const startRecording = useCallback(
    async (setup?: MeetingSetup, deviceName?: string) => {
      try {
        setError(null);
        // 청크 상태 초기화
        chunkTranscripts.current = new Map();
        totalChunksRef.current = null;
        assembleResolveRef.current = null;
        assembleRejectRef.current = null;
        if (assembleTimerRef.current !== null) {
          clearTimeout(assembleTimerRef.current);
          assembleTimerRef.current = null;
        }
        chunkQueue.current = [];
        isProcessingChunk.current = false;
        prevChunkTailRef.current = "";

        // 사전 설정값 보관 — stop / 요약 단계에서 사용
        setupRef.current = setup ?? null;

        // 시스템 오디오 + 마이크 모드는 macOS ScreenCaptureKit 사용 (BlackHole 불필요).
        // 첫 호출 시 권한이 없으면 시스템 프롬프트가 트리거되며 에러 메시지로 안내.
        // 미팅별 setup이 우선, 없으면 settings의 default값.
        const source = setupRef.current?.audio_source
          ?? settingsRef.current?.audio_source
          ?? "microphone";

        await invoke("start_recording", {
          deviceName: deviceName ?? null,
          recordingsPath: settings?.recordings_path ?? null,
          audioSource: source,
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

        const setup = setupRef.current;
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
          meeting_type: setup?.meeting_type ?? null,
          attendees: setup?.attendees && setup.attendees.length > 0 ? setup.attendees : null,
          created_at: now,
        };

        setCurrentMeeting(initialMeeting);

        // 2. 청크 전사 완료 대기 (이미 병렬로 진행 중)
        setProcessingStep("transcribing");
        totalChunksRef.current = recordingResult.total_chunks;

        let fullTranscript: string;
        if (recordingResult.total_chunks === 0) {
          fullTranscript = "";
          setError("녹음이 너무 짧습니다. 최소 3초 이상 녹음해주세요.");
        } else {
          fullTranscript = await waitForAssembly();
        }

        updateCurrentMeeting({ transcript: fullTranscript });

        // 3. Claude CLI 요약 (전사 결과는 이미 DB에 저장돼 있으니 요약 실패해도 데이터는 보존됨)
        if (fullTranscript) {
          setProcessingStep("summarizing");
          try {
            // 사전 체크: 로그인 안 돼 있으면 5분 타임아웃 기다리지 않고 즉시 fail-fast
            await ensureClaudeAuth(settingsRef.current?.claude_path);
            const summary = await summarizeMeeting(
              fullTranscript,
              memo,
              {
                meeting_type: setup?.meeting_type ?? null,
                attendees: setup?.attendees ?? null,
              },
              settingsRef.current?.claude_path,
              settingsRef.current?.claude_model,
            );
            updateCurrentMeeting({ summary });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error("Claude 요약 실패:", msg);
            setError(`요약 실패 — 결과 화면에서 다시 시도할 수 있습니다. (${msg})`);
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
          options: {
            audioPath,
            pythonPath: settings?.python_path,
            model: settings?.whisper_model,
          },
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
    async (
      transcript: string,
      memo: string | null,
      meetingId: string,
      context?: { meeting_type: string | null; attendees: string[] | null }
    ) => {
      try {
        setProcessingStep("summarizing");
        await ensureClaudeAuth(settingsRef.current?.claude_path);
        const summary = await summarizeMeeting(
          transcript,
          memo,
          {
            meeting_type: context?.meeting_type ?? null,
            attendees: context?.attendees ?? null,
          },
          settingsRef.current?.claude_path,
          settingsRef.current?.claude_model
        );
        await updateMeetingSummary(meetingId, summary);
        updateCurrentMeeting({ summary });
        // 재시도 성공 시 이전 실패 알럿이 남아있으면 자동 제거 (UX: 알럿 + 결과 동시 표시 방지)
        setError(null);
        setProcessingStep(null);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(`요약 재시도 실패: ${msg}`);
        setProcessingStep(null);
      }
    },
    [setProcessingStep, updateCurrentMeeting, setError]
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
