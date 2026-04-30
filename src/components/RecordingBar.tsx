import { useState, useEffect, useRef, KeyboardEvent } from "react";
import { Mic, Square, Pause, Play } from "lucide-react";
import { useMeetingStore } from "../store/meetingStore";

const INDENT = "  "; // 2-space indent

// ── 노션 스타일 리스트 마커 ──
// 불릿: -
// 넘버: 레벨에 따라 1./2./3. → a./b./c. → i./ii./iii. (3단계 순환)
type ListType = "bullet" | "numeric" | "letter" | "roman";

interface ListInfo {
  indent: string;
  type: ListType;
  count: number;          // 1-based; 불릿은 항상 1
  prefix: string;         // 줄머리 전체(공백 + 마커 + 공백)
  rest: string;           // 마커 뒤의 본문
}

const ROMAN_TABLE = ["", "i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix",
  "x", "xi", "xii", "xiii", "xiv", "xv", "xvi", "xvii", "xviii", "xix",
  "xx", "xxi", "xxii", "xxiii", "xxiv", "xxv"];
function nToRoman(n: number): string {
  return ROMAN_TABLE[n] ?? `${n}`;
}
function romanToN(s: string): number {
  const idx = ROMAN_TABLE.indexOf(s);
  return idx > 0 ? idx : 0;
}
function nToLetter(n: number): string {
  // 1 → a, 2 → b, ... 26 → z, 그 이후는 단순 wrap
  return String.fromCharCode("a".charCodeAt(0) + ((n - 1) % 26));
}
function letterToN(s: string): number {
  if (!/^[a-z]$/.test(s)) return 0;
  return s.charCodeAt(0) - "a".charCodeAt(0) + 1;
}

// 들여쓰기 레벨(0,1,2,...)에서의 numbered 마커 종류
function typeForLevel(level: number): Exclude<ListType, "bullet"> {
  switch (level % 3) {
    case 0: return "numeric";
    case 1: return "letter";
    default: return "roman";
  }
}

function renderPrefix(indent: string, type: ListType, count: number): string {
  if (type === "bullet") return `${indent}- `;
  if (type === "numeric") return `${indent}${count}. `;
  if (type === "letter") return `${indent}${nToLetter(count)}. `;
  return `${indent}${nToRoman(count)}. `;
}

function parseListLine(line: string): ListInfo | null {
  // 불릿
  let m = line.match(/^(\s*)[-*]\s+/);
  if (m) {
    return { indent: m[1], type: "bullet", count: 1, prefix: m[0], rest: line.slice(m[0].length) };
  }
  // 숫자 마커 (1. 2. ...)
  m = line.match(/^(\s*)(\d+)\.\s+/);
  if (m) {
    return { indent: m[1], type: "numeric", count: parseInt(m[2], 10) || 1, prefix: m[0], rest: line.slice(m[0].length) };
  }
  // 알파/로마 마커 (a. / b. / i. / ii. ...) — 들여쓰기 레벨로 우선 결정
  m = line.match(/^(\s*)([a-z]+)\.\s+/i);
  if (m) {
    const indent = m[1];
    const marker = m[2].toLowerCase();
    const level = Math.floor(indent.length / INDENT.length);
    // 마커 모양으로 후보 결정
    const romanN = romanToN(marker);
    const isRomanShape = romanN > 0;
    const isSingleLetter = marker.length === 1;
    // 레벨이 명확히 가리키는 타입을 우선
    const typeByLevel = typeForLevel(level);
    if (typeByLevel === "roman" && isRomanShape) {
      return { indent, type: "roman", count: romanN, prefix: m[0], rest: line.slice(m[0].length) };
    }
    if (typeByLevel === "letter" && isSingleLetter) {
      return { indent, type: "letter", count: letterToN(marker), prefix: m[0], rest: line.slice(m[0].length) };
    }
    // 레벨이 numeric인데 알파가 들어있는 경우는 무시 (리스트 아님)
    // 그 외엔 모양으로 판단
    if (isRomanShape && !isSingleLetter) {
      return { indent, type: "roman", count: romanN, prefix: m[0], rest: line.slice(m[0].length) };
    }
    if (isSingleLetter) {
      return { indent, type: "letter", count: letterToN(marker), prefix: m[0], rest: line.slice(m[0].length) };
    }
  }
  return null;
}

/**
 * 노션 스타일 키보드 핸들러:
 * - 줄이 `- ` / `1. ` / `a. ` / `i. ` 형태이면 Enter로 다음 항목 자동 생성
 *   (numeric은 +1, letter는 a→b, roman은 i→ii)
 * - 빈 항목에서 Enter → 마커 제거 (리스트 탈출)
 * - Tab: 들여쓰기 한 단계 + numbered 마커 종류 변경 (1→a, a→i)
 * - Shift+Tab: 한 단계 outdent + 마커 종류 되돌림
 * - 한글 IME 조합 중에는 무시
 */
function handleMarkdownKey(
  e: KeyboardEvent<HTMLTextAreaElement>,
  setMemo: (v: string) => void
) {
  if (e.nativeEvent.isComposing) return;
  const el = e.currentTarget;
  const value = el.value;
  const selStart = el.selectionStart;
  const selEnd = el.selectionEnd;
  const lineStartOf = (pos: number) => value.lastIndexOf("\n", pos - 1) + 1;
  const lineEndOf = (pos: number) => {
    const i = value.indexOf("\n", pos);
    return i === -1 ? value.length : i;
  };
  const apply = (newValue: string, newSelStart: number, newSelEnd?: number) => {
    setMemo(newValue);
    requestAnimationFrame(() => {
      el.setSelectionRange(newSelStart, newSelEnd ?? newSelStart);
      el.focus();
    });
  };

  // ── Enter: 리스트 자동 이어쓰기 / 빈 항목 탈출 ──
  if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.altKey && !e.ctrlKey) {
    if (selStart !== selEnd) return;
    const lineStart = lineStartOf(selStart);
    const currentLine = value.slice(lineStart, selStart);
    const info = parseListLine(currentLine);
    if (!info) return;

    e.preventDefault();
    if (info.rest.length === 0) {
      // 빈 항목 → 마커 통째로 제거하고 일반 줄로 빠져나감
      const newValue = value.slice(0, lineStart) + value.slice(selStart);
      apply(newValue, lineStart);
    } else {
      const nextCount = info.type === "bullet" ? 1 : info.count + 1;
      const insert = "\n" + renderPrefix(info.indent, info.type, nextCount);
      const newValue = value.slice(0, selStart) + insert + value.slice(selEnd);
      apply(newValue, selStart + insert.length);
    }
    return;
  }

  // ── Tab / Shift+Tab ──
  if (e.key === "Tab") {
    e.preventDefault();
    const lineStart = lineStartOf(selStart);
    const lineEnd = lineEndOf(selStart);
    const currentLine = value.slice(lineStart, lineEnd);
    const info = parseListLine(currentLine);

    // 리스트 줄이 아닌 경우 — 단순 indent/outdent (기존 동작 유지)
    if (!info) {
      if (e.shiftKey) {
        if (currentLine.startsWith(INDENT)) {
          const newValue = value.slice(0, lineStart) + currentLine.slice(INDENT.length) + value.slice(lineEnd);
          const shift = INDENT.length;
          apply(newValue, Math.max(lineStart, selStart - shift), Math.max(lineStart, selEnd - shift));
        } else if (currentLine.startsWith(" ")) {
          const newValue = value.slice(0, lineStart) + currentLine.slice(1) + value.slice(lineEnd);
          apply(newValue, Math.max(lineStart, selStart - 1), Math.max(lineStart, selEnd - 1));
        }
      } else {
        const newValue = value.slice(0, selStart) + INDENT + value.slice(selEnd);
        apply(newValue, selStart + INDENT.length);
      }
      return;
    }

    // 리스트 줄 — 레벨 변경 + 마커 종류 변경 + count는 1로 리셋
    const currentLevel = Math.floor(info.indent.length / INDENT.length);
    const newLevel = e.shiftKey ? Math.max(0, currentLevel - 1) : currentLevel + 1;

    // 레벨이 안 바뀌면 (top-level에서 Shift+Tab 등) 그대로 둠 — count 손실 방지
    if (newLevel === currentLevel) return;

    const newIndent = INDENT.repeat(newLevel);
    const newType: ListType = info.type === "bullet" ? "bullet" : typeForLevel(newLevel);
    const newPrefix = renderPrefix(newIndent, newType, 1);
    const newLineText = newPrefix + info.rest;
    const newValue = value.slice(0, lineStart) + newLineText + value.slice(lineEnd);

    // 커서 위치 복원: 본문 내 상대 위치 보존
    const cursorOffsetInRest = Math.max(0, selStart - (lineStart + info.prefix.length));
    const newCursor = lineStart + newPrefix.length + cursorOffsetInRest;
    apply(newValue, newCursor);
  }
}

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
      <div className="relative flex flex-col items-center justify-center flex-1 gap-10 overflow-hidden">
        {/* 우측 문양 — 옛 기사 문장(紋章)처럼 양피지에 찍힌 느낌 */}
        <img
          src="/symbol-nobg.png"
          alt=""
          aria-hidden="true"
          className="symbol-crest"
        />

        {/* 워드마크 + 서브 타이틀 */}
        <div className="relative text-center z-10">
          <h1 className="wordmark text-5xl text-white mb-3 tracking-wide">ttiro</h1>
          <div className="editorial-divider w-48 mx-auto mb-3">
            <span className="ornament">· · ·</span>
          </div>
          <p className="text-zinc-400 text-sm">
            녹음하고 · 옮겨 적고 · 정리하다
          </p>
        </div>

        {/* 녹음 버튼 — 다층 그림자로 도장 찍는 느낌 */}
        <button
          onClick={onNewMeeting}
          className="relative w-28 h-28 rounded-full bg-red-600 hover:bg-red-500 active:scale-95 transition-all duration-200 flex items-center justify-center shadow-2xl shadow-red-900/50 z-10 lift-on-hover group"
          style={{
            boxShadow:
              "0 1px 0 rgba(255,255,255,0.15) inset, 0 -2px 8px rgba(0,0,0,0.2) inset, 0 8px 24px rgba(0,0,0,0.35), 0 4px 12px var(--color-red-900, #4a1410)",
          }}
        >
          <Mic size={44} className="text-white drop-shadow-lg" />
          {/* 동심원 펄스 */}
          <span className="absolute inset-0 rounded-full ring-1 ring-white/20 group-hover:ring-white/40 transition-all" />
        </button>

        <p className="relative text-zinc-500 text-xs tracking-widest uppercase z-10" style={{ letterSpacing: "0.2em" }}>
          press to begin
        </p>
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
              onKeyDown={(e) => handleMarkdownKey(e, setMemo)}
              placeholder={
                "예)\n- 결정: Q3까지 신규 가입자 1만 명 목표\n- 액션: 김OO이 광고 예산안 다음 주 월요일까지\n  - Tab으로 들여쓰기, Enter로 같은 레벨 이어쓰기\n- 이슈: 인프라 비용 초과 우려"
              }
              spellCheck={false}
              className="flex-1 bg-zinc-900 text-white rounded-xl px-4 py-3 text-sm placeholder:text-zinc-600 outline-none focus:ring-1 focus:ring-zinc-600 resize-none font-mono leading-relaxed"
            />
          </div>
        </div>
      </div>
    );
  }

  return null;
}
