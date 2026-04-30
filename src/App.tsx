import { useState, useEffect, useCallback, useRef } from "react";
import { getCurrentWebviewWindow, WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Settings, List, ArrowLeft, AlertCircle, X, WifiOff, Sparkles } from "lucide-react";
import { useMeetingStore } from "./store/meetingStore";
import { useSettings } from "./hooks/useSettings";
import { useRecording } from "./hooks/useRecording";
import { useMeetings } from "./hooks/useMeetings";
import { RecordingBar } from "./components/RecordingBar";
import { MeetingSetupView } from "./components/MeetingSetupView";
import { ProcessingView } from "./components/ProcessingView";
import { SummaryView } from "./components/SummaryView";
import { MeetingList } from "./components/MeetingList";
import { SettingsModal } from "./components/SettingsModal";
import { getMeetings, updateMeetingSummary, updateNotionPageId } from "./services/database";
import { summarizeMeeting } from "./services/llm";
import { saveToNotion } from "./services/notion";
import { effectiveHfToken } from "./utils/env";
import type { Meeting, MeetingSetup } from "./types";

type View = "home" | "setup" | "list" | "result";

const WINDOW_LABEL = (() => {
  try {
    return getCurrentWebviewWindow().label;
  } catch {
    return "main";
  }
})();

function useOnlineStatus() {
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setIsOnline(true);
    const off = () => setIsOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return isOnline;
}

/**
 * 캔버스 기반 심볼 렌더러: PNG의 흰 배경 픽셀을 투명 처리.
 * - 밝기 > 250: 완전 투명
 * - 밝기 240~250: 선형 보간 (안티에일리어싱 자연스럽게)
 * - 그 외: 그대로
 */
function TransparentSymbol() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const img = new Image();
    img.src = "/symbol.png";
    img.onload = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, img.width, img.height);
      const data = imageData.data;
      for (let i = 0; i < data.length; i += 4) {
        const brightness = (data[i] + data[i + 1] + data[i + 2]) / 3;
        if (brightness > 250) {
          data[i + 3] = 0;
        } else if (brightness > 240) {
          // 250 → alpha 0, 240 → alpha 255 선형 보간 (반투명 가장자리)
          data[i + 3] = Math.round(((250 - brightness) / 10) * 255);
        }
      }
      ctx.putImageData(imageData, 0, 0);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="max-w-full max-h-full"
      style={{ imageRendering: "auto" }}
    />
  );
}

function SplashWindow() {
  useEffect(() => {
    // 윈도우 전체가 투명하게 보이도록 body 배경도 투명 처리.
    // Splash 전용 webview라 main 윈도우엔 영향 없음.
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";

    const timer = setTimeout(async () => {
      try {
        const main = await WebviewWindow.getByLabel("main");
        if (main) await main.show();
        await getCurrentWebviewWindow().close();
      } catch (e) {
        console.error("splash → main 전환 실패:", e);
      }
    }, 1800);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div
      className="fixed inset-0 flex items-center justify-center"
      style={{ background: "transparent" }}
    >
      <TransparentSymbol />
    </div>
  );
}

export default function App() {
  if (WINDOW_LABEL === "splash") {
    return <SplashWindow />;
  }

  const {
    recordingState,
    currentMeeting,
    error,
    setCurrentMeeting,
    setMeetings,
    setError,
    reset,
  } = useMeetingStore();
  const { settings, loading: settingsLoading, saveSettings } = useSettings();
  const { startRecording, stopRecording, pauseRecording, resumeRecording, retrySummary } = useRecording(settings);
  const { loadMeetings } = useMeetings();
  const isOnline = useOnlineStatus();

  const [view, setView] = useState<View>("home");
  const [showSettings, setShowSettings] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [batchSummarizing, setBatchSummarizing] = useState(false);
  const [pendingSetup, setPendingSetup] = useState<MeetingSetup | null>(null);

  useEffect(() => {
    loadMeetings();
  }, [loadMeetings]);

  // 처리 완료 시 결과 화면으로 전환
  useEffect(() => {
    if (recordingState === "done") {
      setView("result");
    }
  }, [recordingState]);

  // 미처리 미팅 수 계산 (전사 O, 요약 X)
  const refreshPendingCount = useCallback(async () => {
    const all = await getMeetings();
    const count = all.filter((m) => m.transcript && !m.summary).length;
    setPendingCount(count);
  }, []);

  // 미처리 카운트는 미팅이 끝났거나 idle로 돌아왔을 때만 갱신.
  // (중간 상태 transitioning에서 매번 DB 쿼리하지 않도록 — 미팅당 1회 호출)
  useEffect(() => {
    if (recordingState === "done" || recordingState === "idle") {
      refreshPendingCount();
    }
  }, [refreshPendingCount, recordingState]);

  // 일괄 요약 처리
  const handleBatchSummarize = async () => {
    setBatchSummarizing(true);
    try {
      const all = await getMeetings();
      const pending = all.filter((m) => m.transcript && !m.summary);
      let processed = 0;

      for (const meeting of pending) {
        try {
          const summary = await summarizeMeeting(
            meeting.transcript!,
            meeting.memo,
            { meeting_type: meeting.meeting_type, attendees: meeting.attendees },
            settings.claude_path,
            settings.claude_model
          );
          await updateMeetingSummary(meeting.id, summary);

          // Notion 자동 저장 (키가 설정된 경우)
          if (settings.notion_api_key && settings.notion_database_id && !meeting.notion_page_id) {
            try {
              const updatedMeeting = { ...meeting, summary };
              const pageId = await saveToNotion(
                updatedMeeting,
                settings.notion_api_key,
                settings.notion_database_id
              );
              await updateNotionPageId(meeting.id, pageId);
            } catch {
              // Notion 실패는 무시 (요약은 성공)
            }
          }

          processed++;
        } catch (e) {
          console.error(`미팅 ${meeting.id} 요약 실패:`, e);
        }
      }

      const updatedAll = await getMeetings();
      setMeetings(updatedAll);
      await refreshPendingCount();

      if (processed > 0) {
        setError(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBatchSummarizing(false);
    }
  };

  const handleSelectMeeting = (meeting: Meeting) => {
    setCurrentMeeting(meeting);
    setView("result");
  };

  const handleBack = () => {
    if (recordingState === "done" || recordingState === "error") {
      reset();
      setPendingSetup(null); // 다음 미팅 진입 시 이전 setup 잔재 제거
    }
    setView("home");
  };

  const handleRetrySummary = (
    transcript: string,
    memo: string | null,
    meetingId: string
  ) => {
    const meeting = currentMeeting?.id === meetingId ? currentMeeting : null;
    retrySummary(transcript, memo, meetingId, {
      meeting_type: meeting?.meeting_type ?? null,
      attendees: meeting?.attendees ?? null,
    });
  };

  const handleNewMeeting = () => setView("setup");

  const handleSetupStart = async (setup: MeetingSetup) => {
    setPendingSetup(setup);
    setView("home");
    await startRecording(setup);
  };

  if (settingsLoading) {
    return (
      <div className="flex items-center justify-center h-screen bg-zinc-950">
        <div className="w-6 h-6 border-2 border-zinc-600 border-t-white rounded-full animate-spin" />
      </div>
    );
  }

  const isProcessing = recordingState === "processing";
  const isRecordingOrIdle =
    recordingState === "idle" || recordingState === "recording" || recordingState === "paused";

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-white">
      {/* 헤더 */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-zinc-900">
        <div className="flex items-center gap-2">
          {view !== "home" && (
            <button
              onClick={handleBack}
              disabled={isProcessing || recordingState === "recording"}
              className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-white disabled:opacity-30 transition-colors"
            >
              <ArrowLeft size={18} />
            </button>
          )}
          <h1 className={`text-sm font-semibold ${view === "home" ? "wordmark" : ""}`}>
            {view === "list"
              ? "미팅 목록"
              : view === "result"
              ? currentMeeting?.title ?? "미팅 결과"
              : "ttiro"}
          </h1>
        </div>

        <div className="flex items-center gap-1">
          {!isOnline && (
            <div className="flex items-center gap-1 px-2 py-1 rounded-lg bg-zinc-800 text-zinc-400 text-xs">
              <WifiOff size={12} />
              <span>오프라인</span>
            </div>
          )}
          {view === "home" && (
            <button
              onClick={() => setView("list")}
              className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-white transition-colors"
            >
              <List size={18} />
            </button>
          )}
          <button
            onClick={() => setShowSettings(true)}
            className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-white transition-colors"
          >
            <Settings size={18} />
          </button>
        </div>
      </header>

      {/* 미처리 미팅 배너 (온라인 + API 키 있음 + 미처리 있음) */}
      {pendingCount > 0 && view === "home" && recordingState === "idle" && (
        <div className="mx-4 mt-3 flex items-center justify-between p-3 bg-amber-900/30 border border-amber-800 rounded-xl">
          <div className="flex items-center gap-2 text-amber-300 text-sm">
            <Sparkles size={14} />
            <span>미처리 미팅 {pendingCount}개 — 요약 생성 대기 중</span>
          </div>
          <button
            onClick={handleBatchSummarize}
            disabled={batchSummarizing}
            className="text-xs px-3 py-1.5 bg-amber-700 hover:bg-amber-600 disabled:opacity-50 rounded-lg text-white transition-colors"
          >
            {batchSummarizing ? "처리 중..." : "요약 생성하기"}
          </button>
        </div>
      )}

      {/* 에러 배너 */}
      {error && (
        <div className="flex items-start gap-2 mx-4 mt-3 p-3 bg-red-900/30 border border-red-800 rounded-xl text-red-300 text-sm">
          <AlertCircle size={16} className="shrink-0 mt-0.5" />
          <span className="flex-1">{error}</span>
          <button
            onClick={() => setError(null)}
            className="text-red-400 hover:text-red-200 shrink-0"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* 메인 콘텐츠 */}
      <main className="flex-1 overflow-hidden flex flex-col">
        {/* 홈 */}
        {view === "home" && (
          <>
            {isRecordingOrIdle && (
              <RecordingBar
                onNewMeeting={handleNewMeeting}
                onStop={stopRecording}
                onPause={pauseRecording}
                onResume={resumeRecording}
                initialTitle={pendingSetup?.title ?? ""}
              />
            )}
            {isProcessing && <ProcessingView whisperModel={settings.whisper_model} />}

            {/* 최근 미팅록 (idle 상태에서만 표시) */}
            {recordingState === "idle" && (
              <div className="relative z-10 px-6 pb-5 pt-3">
                <div className="editorial-divider mb-4">
                  <span className="ornament text-[10px] tracking-[0.3em] uppercase">최근의 기록</span>
                </div>
                <MeetingList onSelect={handleSelectMeeting} compact />
                <div className="text-center mt-3">
                  <button
                    onClick={() => setView("list")}
                    className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                  >
                    전체 보기 →
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        {/* 새 미팅 설정 */}
        {view === "setup" && (
          <MeetingSetupView
            onCancel={() => setView("home")}
            onStart={handleSetupStart}
            hasHfToken={!!effectiveHfToken(settings.hf_token)}
          />
        )}

        {/* 목록 */}
        {view === "list" && (
          <div className="flex-1 overflow-y-auto p-4">
            <MeetingList onSelect={handleSelectMeeting} />
          </div>
        )}

        {/* 결과 */}
        {view === "result" && (
          <SummaryView
            settings={settings}
            onRetrySummary={handleRetrySummary}
          />
        )}
      </main>

      {/* 설정 모달 */}
      {showSettings && (
        <SettingsModal
          settings={settings}
          onSave={saveSettings}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}
