import { useState, useRef, useEffect, useMemo } from "react";
import { Mic, X, Plus, ArrowLeft, ChevronDown } from "lucide-react";
import { useTeamMembers } from "../hooks/useTeamMembers";
import { useMeetingTypes } from "../hooks/useMeetingTypes";
import type { MeetingSetup } from "../types";

interface Props {
  onCancel: () => void;
  onStart: (setup: MeetingSetup) => void;
}

export function MeetingSetupView({ onCancel, onStart }: Props) {
  const { members } = useTeamMembers();
  const { types } = useMeetingTypes();

  const [title, setTitle] = useState("");
  const [meetingTypeId, setMeetingTypeId] = useState<string | null>(null);
  const [attendees, setAttendees] = useState<string[]>([]);
  const [externalInput, setExternalInput] = useState("");
  const externalRef = useRef<HTMLInputElement>(null);

  // 첫 로드 시 첫 번째 유형(내부미팅)을 디폴트로
  useEffect(() => {
    if (!meetingTypeId && types.length > 0) setMeetingTypeId(types[0].id);
  }, [types, meetingTypeId]);

  const selectedTypeName = useMemo(
    () => types.find((t) => t.id === meetingTypeId)?.name ?? null,
    [types, meetingTypeId]
  );

  const addAttendee = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setAttendees((prev) => (prev.includes(trimmed) ? prev : [...prev, trimmed]));
  };

  const removeAttendee = (name: string) => {
    setAttendees((prev) => prev.filter((a) => a !== name));
  };

  const handleAddExternal = () => {
    const value = externalInput.trim();
    if (!value) return;
    addAttendee(value);
    setExternalInput("");
    externalRef.current?.focus();
  };

  const handleStart = () => {
    onStart({
      title: title.trim() || null,
      meeting_type: selectedTypeName,
      attendees,
    });
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-2xl mx-auto px-6 py-8">
        {/* 상단 */}
        <div className="flex items-center gap-3 mb-8">
          <button
            type="button"
            onClick={onCancel}
            className="p-1.5 -ml-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-white transition-colors"
          >
            <ArrowLeft size={18} />
          </button>
          <div>
            <h1 className="text-xl font-semibold text-white">새 미팅</h1>
            <p className="text-xs text-zinc-500 mt-0.5">
              회의 정보를 미리 설정하면 더 정확한 요약을 받을 수 있어요
            </p>
          </div>
        </div>

        <div className="space-y-7">
          {/* 회의 제목 */}
          <Field label="회의 제목" hint="비우면 날짜로 자동 생성">
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="예) 2026 Q3 마케팅 전략 킥오프"
              className="w-full bg-zinc-900 border border-zinc-800 text-white rounded-xl px-4 py-3.5 text-sm placeholder:text-zinc-600 outline-none focus:border-zinc-600 transition-colors"
              autoFocus
            />
          </Field>

          {/* 미팅 유형 */}
          <Field label="미팅 유형" hint="설정에서 유형 추가/관리 가능">
            <div className="relative">
              <select
                value={meetingTypeId ?? ""}
                onChange={(e) => setMeetingTypeId(e.target.value || null)}
                className="appearance-none w-full bg-zinc-900 border border-zinc-800 text-white rounded-xl px-4 py-3.5 pr-10 text-sm outline-none focus:border-zinc-600 transition-colors cursor-pointer"
              >
                {types.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              <ChevronDown
                size={16}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none"
              />
            </div>
          </Field>

          {/* 참석자 */}
          <Field
            label="참석자"
            hint={
              attendees.length > 0
                ? `${attendees.length}명 선택됨`
                : "팀원은 한 번 클릭으로 추가, 외부인은 직접 입력"
            }
          >
            {/* 선택된 칩 영역 */}
            <div
              className={`min-h-[60px] bg-zinc-900 border border-zinc-800 rounded-xl p-3 flex flex-wrap gap-2 ${
                attendees.length === 0 ? "items-center" : ""
              }`}
            >
              {attendees.length === 0 && (
                <span className="text-xs text-zinc-600 px-1">
                  아직 추가된 참석자가 없습니다
                </span>
              )}
              {attendees.map((name) => (
                <Chip
                  key={name}
                  label={name}
                  onRemove={() => removeAttendee(name)}
                  variant="selected"
                />
              ))}
            </div>

            {/* 팀원 빠른 추가 */}
            {members.length > 0 && (
              <div className="mt-4">
                <p className="text-xs text-zinc-500 mb-2 ml-1">팀원 빠른 추가</p>
                <div className="flex flex-wrap gap-2">
                  {members.map((m) => {
                    const label = m.role ? `${m.name} · ${m.role}` : m.name;
                    const already = attendees.includes(label) || attendees.includes(m.name);
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (!already) addAttendee(label);
                        }}
                        disabled={already}
                        className={`text-xs px-3 py-1.5 rounded-full border transition-all ${
                          already
                            ? "bg-zinc-800/50 border-zinc-800 text-zinc-600 cursor-not-allowed"
                            : "bg-zinc-900 border-zinc-700 text-zinc-300 hover:bg-zinc-800 hover:border-zinc-600 hover:text-white active:scale-95 cursor-pointer"
                        }`}
                      >
                        <span className="text-zinc-400 mr-1">{already ? "✓" : "+"}</span>
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* 외부 참석자 직접 입력 */}
            <div className="mt-4">
              <p className="text-xs text-zinc-500 mb-2 ml-1">외부 참석자 추가</p>
              <div className="flex gap-2">
                <input
                  ref={externalRef}
                  type="text"
                  value={externalInput}
                  onChange={(e) => setExternalInput(e.target.value)}
                  onKeyDown={(e) => {
                    // 한글 IME 조합 중 Enter 무시 (글자 미확정 상태에서 빈값 추가 방지)
                    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      handleAddExternal();
                    }
                  }}
                  placeholder="이름 (선택적으로 ', 직책' 추가) — Enter로 추가"
                  className="flex-1 bg-zinc-900 border border-zinc-800 text-white rounded-xl px-4 py-2.5 text-sm placeholder:text-zinc-600 outline-none focus:border-zinc-600 transition-colors"
                />
                <button
                  type="button"
                  onClick={handleAddExternal}
                  disabled={!externalInput.trim()}
                  className="px-3 rounded-xl bg-zinc-800 hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed text-zinc-300 hover:text-white transition-colors cursor-pointer"
                >
                  <Plus size={16} />
                </button>
              </div>
              {members.length === 0 && (
                <p className="text-xs text-zinc-600 mt-2 ml-1">
                  💡 자주 만나는 팀원은 설정 → 팀원 관리에 등록해두면 한 번 클릭으로 추가됩니다
                </p>
              )}
            </div>
          </Field>
        </div>

        {/* 시작 버튼 */}
        <div className="mt-10 flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="px-5 py-3 rounded-xl text-zinc-400 hover:text-white hover:bg-zinc-900 text-sm transition-colors"
          >
            취소
          </button>
          <button
            type="button"
            onClick={handleStart}
            className="flex items-center gap-2 px-6 py-3 rounded-xl bg-red-600 hover:bg-red-500 active:scale-[0.98] text-white text-sm font-medium shadow-lg shadow-red-900/30 transition-all cursor-pointer"
          >
            <Mic size={16} />
            녹음 시작
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-2.5">
        <label className="text-sm font-medium text-zinc-200">{label}</label>
        {hint && <span className="text-xs text-zinc-600">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function Chip({
  label,
  onRemove,
  variant = "selected",
}: {
  label: string;
  onRemove?: () => void;
  variant?: "selected";
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 pl-3 pr-1.5 py-1.5 rounded-full text-xs ${
        variant === "selected"
          ? "bg-zinc-800 text-white border border-zinc-700"
          : "bg-zinc-900 text-zinc-300 border border-zinc-800"
      }`}
    >
      {label}
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onRemove();
          }}
          className="ml-0.5 w-4 h-4 rounded-full hover:bg-zinc-700 flex items-center justify-center text-zinc-400 hover:text-white transition-colors cursor-pointer"
        >
          <X size={11} />
        </button>
      )}
    </span>
  );
}
