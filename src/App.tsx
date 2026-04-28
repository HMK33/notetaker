import { useState, useEffect, useCallback } from "react";
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
import type { Meeting, MeetingSetup } from "./types";

type View = "home" | "setup" | "list" | "result";

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

export default function App() {
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

  useEffect(() => {
    refreshPendingCount();
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
          <h1 className="text-sm font-semibold">
            {view === "list"
              ? "미팅 목록"
              : view === "result"
              ? currentMeeting?.title ?? "미팅 결과"
              : "Notetaker"}
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
              <div className="px-4 pb-4">
                <div className="flex items-center justify-between mb-2">
                  <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">
                    최근 미팅
                  </h2>
                  <button
                    onClick={() => setView("list")}
                    className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                  >
                    전체 보기
                  </button>
                </div>
                <MeetingList onSelect={handleSelectMeeting} compact />
              </div>
            )}
          </>
        )}

        {/* 새 미팅 설정 */}
        {view === "setup" && (
          <MeetingSetupView
            onCancel={() => setView("home")}
            onStart={handleSetupStart}
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
