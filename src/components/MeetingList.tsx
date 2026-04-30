import { useState } from "react";
import { MoreHorizontal, Trash2, FileAudio, CheckCircle2, Clock } from "lucide-react";
import { format } from "date-fns";
import { ko } from "date-fns/locale";
import { useMeetingStore } from "../store/meetingStore";
import { useMeetings } from "../hooks/useMeetings";
import type { Meeting } from "../types";

interface MeetingListProps {
  onSelect: (meeting: Meeting) => void;
  compact?: boolean;
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}시간 ${m % 60}분`;
  }
  return `${m}분 ${s}초`;
}

interface MeetingCardMenuProps {
  onDeleteAudio: () => void;
  onDeleteAll: () => void;
}

function MeetingCardMenu({ onDeleteAudio, onDeleteAll }: MeetingCardMenuProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
        className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-zinc-700 text-zinc-500 hover:text-zinc-300 transition-colors"
      >
        <MoreHorizontal size={16} />
      </button>

      {open && (
        <>
          <div
            className="fixed inset-0 z-10"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
            }}
          />
          <div className="absolute right-0 top-8 z-20 bg-zinc-800 border border-zinc-700 rounded-xl shadow-2xl py-1 min-w-40">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                onDeleteAudio();
              }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-700 hover:text-white transition-colors"
            >
              <FileAudio size={14} />
              녹음 파일 삭제
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                onDeleteAll();
              }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-400 hover:bg-red-900/30 transition-colors"
            >
              <Trash2 size={14} />
              미팅록 전체 삭제
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function MeetingList({ onSelect, compact = false }: MeetingListProps) {
  const { meetings } = useMeetingStore();
  const { deleteMeeting, deleteAudioFile } = useMeetings();
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const displayedMeetings = compact ? meetings.slice(0, 5) : meetings;

  if (meetings.length === 0) {
    return (
      <div className="text-center py-8 text-zinc-600">
        <Clock size={32} className="mx-auto mb-2 opacity-50" />
        <p className="text-sm">아직 미팅록이 없습니다</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {displayedMeetings.map((meeting) => (
        <div
          key={meeting.id}
          onClick={() => onSelect(meeting)}
          className="group flex items-center gap-3 p-3 bg-zinc-900 hover:bg-zinc-800 rounded-xl cursor-pointer transition-colors"
        >
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium text-white truncate">
                {meeting.title ??
                  format(new Date(meeting.recorded_at), "yyyy-MM-dd 미팅")}
              </p>
              {meeting.notion_page_id && (
                <CheckCircle2 size={12} className="text-green-400 shrink-0" />
              )}
            </div>
            <div className="flex items-center gap-2 mt-0.5 text-xs text-zinc-500">
              <span>
                {format(new Date(meeting.recorded_at), "M월 d일 HH:mm", {
                  locale: ko,
                })}
              </span>
              <span>•</span>
              <span>{formatDuration(meeting.duration_sec)}</span>
            </div>
          </div>

          <MeetingCardMenu
            onDeleteAudio={async () => {
              await deleteAudioFile(meeting.audio_path);
            }}
            onDeleteAll={() => {
              setDeleteConfirm(meeting.id);
            }}
          />
        </div>
      ))}

      {/* 전체 삭제 확인 다이얼로그 */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
          <div className="bg-zinc-900 border border-zinc-700 rounded-2xl p-6 w-80 shadow-2xl">
            <h3 className="text-white font-semibold mb-2">미팅록 삭제</h3>
            <p className="text-zinc-400 text-sm mb-6">
              녹음 파일, 전사본, 요약 정보가 모두 삭제됩니다. 이 작업은 되돌릴 수 없습니다.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="flex-1 py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-sm text-white transition-colors"
              >
                취소
              </button>
              <button
                onClick={async () => {
                  const m = meetings.find((x) => x.id === deleteConfirm);
                  if (m) await deleteMeeting(m.id, m.audio_path, true);
                  setDeleteConfirm(null);
                }}
                className="flex-1 py-2.5 rounded-xl bg-red-700 hover:bg-red-600 text-sm text-white transition-colors"
              >
                삭제
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
