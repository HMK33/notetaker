import { useState, useEffect, useRef } from "react";
import { Mic, Square, Pause, Play } from "lucide-react";
import { useMeetingStore } from "../store/meetingStore";

interface RecordingBarProps {
  onNewMeeting: () => void;
  onStop: (title: string | null, memo: string | null) => void;
  onPause: () => void;
  onResume: () => void;
  initialTitle?: string;
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map((v) => v.toString().padStart(2, "0")).join(":");
}

export function Waveform({ level }: { level: number }) {
  const bars = 20;
  return (
    <div className="flex items-center gap-0.5 h-8">
      {Array.from({ length: bars }).map((_, i) => {
        const center = Math.abs(i - bars / 2) / (bars / 2);
        const height = Math.max(4, level * 100 * (1 - center * 0.5));
        return (
          <div
            key={i}
            className="w-1 rounded-full bg-red-500 transition-all duration-75"
            style={{ height: `${Math.min(height, 32)}px` }}
          />
        );
      })}
    </div>
  );
}

export function RecordingBar({
  onNewMeeting,
  onStop,
  onPause,
  onResume,
  initialTitle = "",
}: RecordingBarProps) {
  const { recordingState, audioLevel } = useMeetingStore();
  const [elapsed, setElapsed] = useState(0);
  const [title, setTitle] = useState(initialTitle);
  const [memo, setMemo] = useState("");
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 새 녹음 시작 시 사전 설정한 제목으로 리셋
  useEffect(() => {
    if (recordingState === "recording" && initialTitle && !title) {
      setTitle(initialTitle);
    }
    // initialTitle 변경 (새 미팅 진입) 시 그대로 반영
  }, [initialTitle, recordingState, title]);

  useEffect(() => {
    if (recordingState === "recording") {
      if (!timerRef.current) {
        timerRef.current = setInterval(() => {
          setElapsed((prev) => prev + 1);
        }, 1000);
      }
    } else if (recordingState === "paused") {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
      if (recordingState === "idle") setElapsed(0);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [recordingState]);

  const handleStop = () => {
    onStop(title.trim() || null, memo.trim() || null);
    setTitle("");
    setMemo("");
  };

  if (recordingState === "idle") {
    return (
      <div className="flex flex-col items-center justify-center flex-1 gap-8">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-white mb-2">Notetaker</h1>
          <p className="text-zinc-400 text-sm">미팅을 녹음하고 AI로 요약하세요</p>
        </div>
        <button
          onClick={onNewMeeting}
          className="w-28 h-28 rounded-full bg-red-600 hover:bg-red-500 active:scale-95 transition-all duration-150 flex items-center justify-center shadow-2xl shadow-red-900/50"
        >
          <Mic size={44} className="text-white" />
        </button>
        <p className="text-zinc-500 text-xs">클릭하여 새 미팅 시작</p>
      </div>
    );
  }

  if (recordingState === "recording" || recordingState === "paused") {
    const isPaused = recordingState === "paused";
    return (
      <div className="flex-1 flex flex-col gap-3 p-4 min-h-0">
        {/* 타이머 + 파형 + 버튼 */}
        <div className="flex items-center justify-between bg-zinc-900 rounded-2xl p-4 shrink-0">
          <div className="flex items-center gap-2">
            <div
              className={`w-3 h-3 rounded-full ${
                isPaused ? "bg-yellow-500" : "bg-red-500 animate-pulse"
              }`}
            />
            <span className="font-mono text-white text-xl tracking-wider">
              {formatTime(elapsed)}
            </span>
            {isPaused && (
              <span className="text-yellow-500 text-xs font-medium">일시정지</span>
            )}
          </div>

          {!isPaused && <Waveform level={audioLevel} />}
          {isPaused && <div className="flex-1" />}

          <div className="flex items-center gap-2">
            <button
              onClick={isPaused ? onResume : onPause}
              className="w-12 h-12 rounded-full bg-zinc-700 hover:bg-zinc-600 active:scale-95 transition-all flex items-center justify-center"
            >
              {isPaused ? (
                <Play size={20} className="text-white fill-white ml-0.5" />
              ) : (
                <Pause size={20} className="text-white fill-white" />
              )}
            </button>

            <button
              onClick={handleStop}
              className="w-12 h-12 rounded-full bg-zinc-700 hover:bg-zinc-600 active:scale-95 transition-all flex items-center justify-center"
            >
              <Square size={20} className="text-white fill-white" />
            </button>
          </div>
        </div>

        {/* 좌측: 안내문, 우측: 제목 + 실시간 노트 */}
        <div className="flex-1 flex gap-3 min-h-0">
          <div className="w-64 shrink-0">
            <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-3 text-xs text-zinc-400 leading-relaxed">
              <p className="text-zinc-300 font-medium mb-1.5">실시간 노트</p>
              <p>
                회의 중 핵심·결정·액션을 직접 적어두세요.
              </p>
              <p className="mt-1.5 text-zinc-500">
                노트는 Whisper 전사보다 <span className="text-zinc-300">우선 신뢰</span>되어 요약에 반영됩니다.
                Whisper가 놓친 디테일을 사람의 노트로 보완하는 구조입니다.
              </p>
            </div>
          </div>

          <div className="flex-1 flex flex-col gap-3 min-h-0">
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="회의록 제목 (선택사항 — 비우면 날짜로 자동 생성)"
              className="bg-zinc-900 text-white rounded-xl px-4 py-3 text-sm placeholder:text-zinc-500 outline-none focus:ring-1 focus:ring-zinc-600 shrink-0"
            />
            <textarea
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder={
                "예)\n- 결정: Q3까지 신규 가입자 1만 명 목표\n- 액션: 김OO이 광고 예산안 다음 주 월요일까지\n- 이슈: 인프라 비용 초과 우려\n"
              }
              className="flex-1 bg-zinc-900 text-white rounded-xl px-4 py-3 text-sm placeholder:text-zinc-600 outline-none focus:ring-1 focus:ring-zinc-600 resize-none font-mono leading-relaxed"
            />
          </div>
        </div>
      </div>
    );
  }

  return null;
}
