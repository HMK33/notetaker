import { useState } from "react";
import { Copy, RefreshCw, Upload, Check, AlertTriangle, Clock, Calendar, Timer, Tag, Users } from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { format } from "date-fns";
import { useMeetingStore } from "../store/meetingStore";
import { saveToNotion } from "../services/notion";
import { updateNotionPageId } from "../services/database";
import type { AppSettings, Meeting, MeetingSummary } from "../types";

interface SummaryViewProps {
  settings: AppSettings;
  onRetrySummary: (transcript: string, memo: string | null, meetingId: string) => void;
}

export function SummaryView({ settings, onRetrySummary }: SummaryViewProps) {
  const { currentMeeting, updateCurrentMeeting } = useMeetingStore();
  const [activeTab, setActiveTab] = useState<"summary" | "transcript">("summary");
  const [copied, setCopied] = useState(false);
  const [notionSaving, setNotionSaving] = useState(false);
  const [notionError, setNotionError] = useState<string | null>(null);

  if (!currentMeeting) return null;

  const { summary, transcript, memo, id } = currentMeeting;

  const handleCopy = async () => {
    const text =
      activeTab === "summary"
        ? formatSummaryText(currentMeeting, summary)
        : (transcript ?? "전사 결과가 없습니다.");
    await writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSaveToNotion = async () => {
    if (!settings.notion_api_key || !settings.notion_database_id) {
      setNotionError("Notion API 키와 Database ID를 설정해주세요.");
      return;
    }
    setNotionSaving(true);
    setNotionError(null);
    try {
      const pageId = await saveToNotion(
        currentMeeting,
        settings.notion_api_key,
        settings.notion_database_id
      );
      await updateNotionPageId(id, pageId);
      updateCurrentMeeting({ notion_page_id: pageId });
    } catch (e) {
      setNotionError(e instanceof Error ? e.message : String(e));
    } finally {
      setNotionSaving(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* 탭 */}
      <div className="flex border-b border-zinc-800">
        {(["summary", "transcript"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-6 py-3 text-sm font-medium transition-colors ${
              activeTab === tab
                ? "text-white border-b-2 border-white"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {tab === "summary" ? "회의록" : "전사"}
          </button>
        ))}
      </div>

      {/* 내용 */}
      <div className="flex-1 overflow-y-auto p-4">
        <MeetingMetadata meeting={currentMeeting} />
        {activeTab === "summary" ? (
          <SummaryContent summary={summary} />
        ) : (
          <p className="text-zinc-300 text-sm whitespace-pre-wrap leading-relaxed">
            {transcript || "전사 결과가 없습니다."}
          </p>
        )}
      </div>

      {notionError && (
        <div className="mx-4 mb-2 p-3 bg-red-900/30 border border-red-800 rounded-xl text-red-300 text-xs">
          {notionError}
        </div>
      )}

      {/* 액션 버튼 */}
      <div className="p-4 border-t border-zinc-800 flex gap-2">
        <button
          onClick={handleSaveToNotion}
          disabled={notionSaving || !!currentMeeting.notion_page_id}
          className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm text-white transition-colors"
        >
          {currentMeeting.notion_page_id ? (
            <><Check size={14} className="text-green-400" /> Notion 저장 완료</>
          ) : notionSaving ? (
            <><RefreshCw size={14} className="animate-spin" /> 저장 중...</>
          ) : (
            <><Upload size={14} /> Notion에 저장</>
          )}
        </button>
        <button
          onClick={handleCopy}
          className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-sm text-white transition-colors"
        >
          {copied ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
          복사
        </button>
        <button
          onClick={() => onRetrySummary(transcript ?? "", memo, id)}
          disabled={!transcript}
          className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm text-white transition-colors"
        >
          <RefreshCw size={14} />
          다시 요약
        </button>
      </div>
    </div>
  );
}

function SummaryContent({ summary }: { summary: MeetingSummary | null }) {
  if (!summary) {
    return (
      <p className="text-zinc-500 text-sm text-center mt-8">
        요약 결과가 없습니다. 아래 버튼으로 다시 시도해보세요.
      </p>
    );
  }

  const { executive_summary, key_decisions, detailed_discussion, action_items, blocking_issues, parking_lot } = summary;

  return (
    <div className="space-y-6">
      {/* 1. Executive Summary */}
      <Section label="1" title="Executive Summary">
        <div className="space-y-3">
          <div>
            <span className="text-xs text-zinc-500 font-medium">회의 목적</span>
            <p className="text-zinc-300 text-sm mt-0.5">{executive_summary.purpose}</p>
          </div>
          {executive_summary.main_conclusions.length > 0 && (
            <div>
              <span className="text-xs text-zinc-500 font-medium">주요 결론</span>
              <ul className="mt-0.5 space-y-1">
                {executive_summary.main_conclusions.map((c, i) => (
                  <li key={i} className="text-zinc-300 text-sm flex gap-2">
                    <span className="text-zinc-500 shrink-0">•</span>{c}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {executive_summary.key_agenda.length > 0 && (
            <div>
              <span className="text-xs text-zinc-500 font-medium">핵심 안건</span>
              <div className="flex flex-wrap gap-1.5 mt-1">
                {executive_summary.key_agenda.map((a, i) => (
                  <span key={i} className="text-xs bg-zinc-800 text-zinc-300 px-2 py-0.5 rounded-full">{a}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      </Section>

      {/* 2. Key Decisions */}
      {key_decisions.length > 0 && (
        <Section label="2" title="Key Decisions">
          <ul className="space-y-2">
            {key_decisions.map((d, i) => (
              <li key={i} className="text-zinc-300 text-sm flex gap-2">
                <span className="text-green-500 shrink-0 mt-0.5">✓</span>{d}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* 3. Detailed Discussion */}
      {detailed_discussion.length > 0 && (
        <Section label="3" title="Detailed Discussion">
          <div className="space-y-4">
            {detailed_discussion.map((topic, i) => (
              <div key={i} className="bg-zinc-900 rounded-xl p-3">
                <p className="text-white text-sm font-medium mb-2">{topic.topic}</p>
                <ul className="space-y-1 mb-2">
                  {topic.contents.map((c, j) => (
                    <li key={j} className="text-zinc-300 text-sm flex gap-2">
                      <span className="text-zinc-500 shrink-0">•</span>{c}
                    </li>
                  ))}
                </ul>
                {topic.issues.length > 0 && (
                  <ul className="space-y-1 border-t border-zinc-800 pt-2 mt-2">
                    {topic.issues.map((issue, j) => (
                      <li key={j} className="text-yellow-400 text-xs flex gap-1.5">
                        <AlertTriangle size={12} className="shrink-0 mt-0.5" />{issue}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* 4. Action Items */}
      {action_items.length > 0 && (
        <Section label="4" title="Action Items">
          <ul className="space-y-2">
            {action_items.map((item, i) => (
              <li key={i} className="text-sm bg-zinc-900 rounded-lg p-3 flex gap-3">
                <span className="text-zinc-600 shrink-0 mt-0.5">[ ]</span>
                <div className="flex-1">
                  <p className="text-white">{item.task}</p>
                  <div className="flex gap-3 mt-1 text-xs text-zinc-500">
                    {item.owner && <span>담당: {item.owner}</span>}
                    {item.due && <span>기한: {item.due}</span>}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* 5. Blocking Issues & Risks */}
      <Section label="5" title="Blocking Issues & Risks">
        <ul className="space-y-1">
          {blocking_issues.map((b, i) => (
            <li key={i} className="text-zinc-300 text-sm flex gap-2">
              <span className="text-red-400 shrink-0">⚠</span>{b}
            </li>
          ))}
        </ul>
      </Section>

      {/* 6. Parking Lot */}
      {parking_lot.length > 0 && (
        <Section label="6" title="Parking Lot">
          <ul className="space-y-1">
            {parking_lot.map((p, i) => (
              <li key={i} className="text-zinc-300 text-sm flex gap-2">
                <Clock size={14} className="text-zinc-500 shrink-0 mt-0.5" />{p}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

function MeetingMetadata({ meeting }: { meeting: Meeting }) {
  const recordedAt = format(new Date(meeting.recorded_at), "yyyy.MM.dd HH:mm");
  const durationMin = (meeting.duration_sec / 60).toFixed(1);
  const hasAttendees = meeting.attendees && meeting.attendees.length > 0;
  const hasType = !!meeting.meeting_type;

  return (
    <div className="mb-6 pb-4 border-b border-zinc-900">
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-zinc-500">
        <span className="flex items-center gap-1.5">
          <Calendar size={12} />
          {recordedAt}
        </span>
        <span className="flex items-center gap-1.5">
          <Timer size={12} />
          {durationMin}분
        </span>
        {hasType && (
          <span className="flex items-center gap-1.5">
            <Tag size={12} />
            {meeting.meeting_type}
          </span>
        )}
      </div>
      {hasAttendees && (
        <div className="mt-3 flex items-start gap-2">
          <Users size={12} className="text-zinc-500 mt-1 shrink-0" />
          <div className="flex flex-wrap gap-1.5">
            {meeting.attendees!.map((name) => (
              <span
                key={name}
                className="text-xs bg-zinc-900 border border-zinc-800 text-zinc-300 px-2 py-0.5 rounded-full"
              >
                {name}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const ROMAN_NUMERALS: Record<string, string> = {
  "1": "I", "2": "II", "3": "III", "4": "IV", "5": "V", "6": "VI",
  "7": "VII", "8": "VIII", "9": "IX",
};

function Section({ label, title, children }: { label: string; title: string; children: React.ReactNode }) {
  const roman = ROMAN_NUMERALS[label] ?? label;
  return (
    <div>
      <h3 className="mb-4 flex items-baseline gap-3">
        <span className="serif-numeral text-zinc-500 text-sm w-6 text-right shrink-0">{roman}.</span>
        <span className="wordmark text-base text-white tracking-tight">{title}</span>
        <span className="flex-1 h-px bg-zinc-800 ml-2" />
      </h3>
      {children}
    </div>
  );
}

function formatSummaryText(meeting: Meeting, summary: MeetingSummary | null): string {
  if (!summary) return "요약 결과가 없습니다.";
  const { executive_summary: es, key_decisions, detailed_discussion, action_items, blocking_issues, parking_lot } = summary;

  const recordedAt = format(new Date(meeting.recorded_at), "yyyy.MM.dd HH:mm");
  const durationMin = (meeting.duration_sec / 60).toFixed(1);

  const headerLines = [
    `# ${meeting.title ?? "회의록"}`,
    "",
    `📅 ${recordedAt} · ⏱ ${durationMin}분${meeting.meeting_type ? ` · 🏷 ${meeting.meeting_type}` : ""}`,
  ];
  if (meeting.attendees && meeting.attendees.length > 0) {
    headerLines.push(`👥 참석자: ${meeting.attendees.join(", ")}`);
  }
  headerLines.push("");

  const lines = [
    ...headerLines,
    `## 1. Executive Summary`,
    `- 회의 목적: ${es.purpose}`,
    `- 주요 결론:\n${es.main_conclusions.map(c => `  • ${c}`).join("\n")}`,
    `- 핵심 안건: ${es.key_agenda.join(", ")}`,
    `\n## 2. Key Decisions`,
    ...key_decisions.map(d => `- ✓ ${d}`),
    `\n## 3. Detailed Discussion`,
    ...detailed_discussion.map(t => [
      `\n**${t.topic}**`,
      ...t.contents.map(c => `  • ${c}`),
      ...t.issues.map(i => `  ⚠ ${i}`),
    ].join("\n")),
    `\n## 4. Action Items`,
    ...action_items.map(a => {
      let line = `[ ] ${a.task}`;
      if (a.owner) line += ` | ${a.owner}`;
      if (a.due) line += ` | ${a.due}`;
      return line;
    }),
    `\n## 5. Blocking Issues & Risks`,
    ...blocking_issues.map(b => `- ⚠ ${b}`),
  ];

  if (parking_lot.length > 0) {
    lines.push(`\n## 6. Parking Lot`, ...parking_lot.map(p => `- ${p}`));
  }

  return lines.join("\n");
}
