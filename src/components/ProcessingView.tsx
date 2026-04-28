import { Check, Loader2 } from "lucide-react";
import { useMeetingStore } from "../store/meetingStore";
import type { ProcessingStep } from "../types";

interface ProcessingViewProps {
  whisperModel?: string;
}

const STEP_ORDER: ProcessingStep[] = ["saving", "transcribing", "summarizing"];

export function ProcessingView({ whisperModel }: ProcessingViewProps) {
  const { processingStep } = useMeetingStore();
  const currentIdx = STEP_ORDER.indexOf(processingStep);

  // 모델명에서 짧은 이름 추출 (예: "mlx-community/whisper-large-v3" → "large-v3")
  const modelShortName = whisperModel
    ? whisperModel.replace("mlx-community/whisper-", "").replace("-mlx", "")
    : "";

  const STEPS: { key: ProcessingStep; label: string; emoji: string }[] = [
    { key: "saving", label: "음성 파일 저장 중...", emoji: "🎙️" },
    {
      key: "transcribing",
      label: `Whisper 전사 중...${modelShortName ? ` (${modelShortName})` : ""}`,
      emoji: "📝",
    },
    { key: "summarizing", label: "AI 요약 생성 중...", emoji: "✨" },
  ];


  return (
    <div className="flex flex-col items-center justify-center flex-1 gap-8 p-8">
      <div className="text-center">
        <h2 className="text-xl font-semibold text-white">처리 중...</h2>
        <p className="text-zinc-400 text-sm mt-1">잠시만 기다려주세요</p>
      </div>

      <div className="w-full max-w-sm space-y-3">
        {STEPS.map((step, idx) => {
          const isDone = idx < currentIdx;
          const isActive = idx === currentIdx;

          return (
            <div
              key={step.key}
              className={`flex items-center gap-3 p-4 rounded-xl transition-all duration-300 ${
                isActive
                  ? "bg-zinc-800 border border-zinc-600"
                  : isDone
                  ? "bg-zinc-900 opacity-60"
                  : "bg-zinc-900 opacity-30"
              }`}
            >
              <span className="text-xl">{step.emoji}</span>
              <span
                className={`flex-1 text-sm ${
                  isActive ? "text-white" : isDone ? "text-zinc-400" : "text-zinc-600"
                }`}
              >
                {isDone
                  ? step.label.replace("중...", "완료")
                  : step.label}
              </span>
              {isDone ? (
                <Check size={16} className="text-green-400" />
              ) : isActive ? (
                <Loader2 size={16} className="text-zinc-400 animate-spin" />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
