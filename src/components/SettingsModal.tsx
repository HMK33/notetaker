import { useState } from "react";
import { X, Eye, EyeOff, FolderOpen, Plus, Trash2, Lock } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import type { AppSettings, WhisperModel, AudioSource } from "../types";
import { useTeamMembers } from "../hooks/useTeamMembers";
import { useMeetingTypes } from "../hooks/useMeetingTypes";

interface SettingsModalProps {
  settings: AppSettings;
  onSave: (settings: AppSettings) => void;
  onClose: () => void;
}

const WHISPER_MODELS: { value: WhisperModel; label: string }[] = [
  { value: "mlx-community/whisper-large-v3-mlx", label: "large-v3 ★ (최고 품질, ~3GB)" },
  { value: "mlx-community/whisper-large-v3-turbo", label: "large-v3-turbo (빠름, ~1.6GB)" },
  { value: "mlx-community/whisper-medium-mlx", label: "medium (~1.5GB)" },
  { value: "mlx-community/whisper-small-mlx", label: "small (~500MB)" },
  { value: "mlx-community/whisper-tiny-mlx", label: "tiny (~150MB, 매우 빠름)" },
];

function ApiKeyInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div>
      <label className="block text-xs text-zinc-400 mb-1.5">{label}</label>
      <div className="relative">
        <input
          type={visible ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full bg-zinc-900 text-white rounded-xl px-4 py-3 pr-10 text-sm placeholder:text-zinc-600 outline-none focus:ring-1 focus:ring-zinc-600"
        />
        <button
          type="button"
          onClick={() => setVisible(!visible)}
          className="absolute right-3 top-3 text-zinc-500 hover:text-zinc-300"
        >
          {visible ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
    </div>
  );
}

export function SettingsModal({ settings, onSave, onClose }: SettingsModalProps) {
  const [form, setForm] = useState<AppSettings>({ ...settings });
  const [saving, setSaving] = useState(false);

  const update = (key: keyof AppSettings) => (value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(form);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const handleOpenFolder = async () => {
    await invoke("open_recordings_folder", {
      recordingsPath: form.recordings_path || null,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-[480px] max-h-[85vh] overflow-y-auto shadow-2xl">
        {/* 헤더 */}
        <div className="flex items-center justify-between p-5 border-b border-zinc-800">
          <h2 className="text-white font-semibold">설정</h2>
          <button
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {/* AI 설정 */}
          <Section title="AI 설정">
            <div>
              <label className="block text-xs text-zinc-400 mb-1.5">Claude CLI 경로</label>
              <input
                type="text"
                value={form.claude_path}
                onChange={(e) => update("claude_path")(e.target.value)}
                placeholder="claude 또는 /usr/local/bin/claude"
                className="w-full bg-zinc-900 text-white rounded-xl px-4 py-3 text-sm placeholder:text-zinc-600 outline-none focus:ring-1 focus:ring-zinc-600"
              />
              <p className="text-zinc-600 text-xs mt-1">
                Claude Code CLI가 설치된 경로 (기본값: claude)
              </p>
            </div>
          </Section>

          {/* Notion 설정 */}
          <Section title="Notion 설정">
            <ApiKeyInput
              label="Notion API Key"
              value={form.notion_api_key}
              onChange={update("notion_api_key")}
              placeholder="secret_..."
            />
            <div className="mt-3">
              <label className="block text-xs text-zinc-400 mb-1.5">Notion Database ID</label>
              <input
                type="text"
                value={form.notion_database_id}
                onChange={(e) => update("notion_database_id")(e.target.value)}
                placeholder="32자리 ID (URL에서 복사)"
                className="w-full bg-zinc-800 text-white rounded-xl px-4 py-3 text-sm placeholder:text-zinc-600 outline-none focus:ring-1 focus:ring-zinc-600"
              />
            </div>
          </Section>

          {/* Whisper 설정 */}
          <Section title="Whisper 설정">
            <div>
              <label className="block text-xs text-zinc-400 mb-1.5">모델 선택</label>
              <select
                value={form.whisper_model}
                onChange={(e) => update("whisper_model")(e.target.value)}
                className="w-full bg-zinc-800 text-white rounded-xl px-4 py-3 text-sm outline-none focus:ring-1 focus:ring-zinc-600"
              >
                {WHISPER_MODELS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="mt-3">
              <label className="block text-xs text-zinc-400 mb-1.5">Python 실행 경로</label>
              <input
                type="text"
                value={form.python_path}
                onChange={(e) => update("python_path")(e.target.value)}
                placeholder="/usr/bin/python3 또는 /opt/homebrew/bin/python3"
                className="w-full bg-zinc-800 text-white rounded-xl px-4 py-3 text-sm placeholder:text-zinc-600 outline-none focus:ring-1 focus:ring-zinc-600"
              />
              <p className="text-zinc-600 text-xs mt-1">
                mlx-whisper가 설치된 Python 경로를 입력하세요
              </p>
            </div>
          </Section>

          {/* 오디오 설정 */}
          <Section title="오디오 소스">
            <div className="space-y-2">
              {(
                [
                  {
                    value: "microphone" as AudioSource,
                    label: "마이크만",
                    desc: "오프라인 미팅에 적합",
                  },
                  {
                    value: "system_and_mic" as AudioSource,
                    label: "시스템 오디오 + 마이크",
                    desc: "Zoom / Google Meet 등 화상회의 (첫 사용 시 화면 녹화 권한 필요)",
                  },
                ] as const
              ).map((opt) => (
                <label
                  key={opt.value}
                  className="flex items-start gap-3 p-3 bg-zinc-800 rounded-xl cursor-pointer"
                >
                  <input
                    type="radio"
                    name="audio_source"
                    value={opt.value}
                    checked={form.audio_source === opt.value}
                    onChange={() => update("audio_source")(opt.value)}
                    className="mt-0.5"
                  />
                  <div>
                    <p className="text-sm text-white">{opt.label}</p>
                    <p className="text-xs text-zinc-500">{opt.desc}</p>
                  </div>
                </label>
              ))}
            </div>
          </Section>

          {/* 팀원 관리 */}
          <Section title="팀원 관리">
            <TeamMembersEditor />
            <p className="text-zinc-600 text-xs mt-2">
              새 미팅 시작 시 한 번 클릭으로 참석자 추가에 사용됩니다.
            </p>
          </Section>

          {/* 미팅 유형 관리 */}
          <Section title="미팅 유형">
            <MeetingTypesEditor />
            <p className="text-zinc-600 text-xs mt-2">
              내부미팅·외부미팅은 기본 유형이라 삭제할 수 없습니다.
            </p>
          </Section>

          {/* 저장 경로 */}
          <Section title="녹음 파일 저장 경로">
            <div className="flex gap-2">
              <input
                type="text"
                value={form.recordings_path}
                onChange={(e) => update("recordings_path")(e.target.value)}
                placeholder="기본값: ~/Documents/Notetaker/"
                className="flex-1 bg-zinc-800 text-white rounded-xl px-4 py-3 text-sm placeholder:text-zinc-600 outline-none focus:ring-1 focus:ring-zinc-600"
              />
              <button
                onClick={handleOpenFolder}
                className="px-3 py-2 bg-zinc-800 hover:bg-zinc-700 rounded-xl text-zinc-400 hover:text-white transition-colors"
              >
                <FolderOpen size={16} />
              </button>
            </div>
          </Section>
        </div>

        {/* 저장 버튼 */}
        <div className="p-5 border-t border-zinc-800">
          <button
            onClick={handleSave}
            disabled={saving}
            className="w-full py-3 bg-white text-black rounded-xl font-medium text-sm hover:bg-zinc-100 disabled:opacity-50 transition-colors"
          >
            {saving ? "저장 중..." : "저장"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">
        {title}
      </h3>
      {children}
    </div>
  );
}

function TeamMembersEditor() {
  const { members, add, remove } = useTeamMembers();
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [busy, setBusy] = useState(false);

  const handleAdd = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      await add(trimmed, role.trim() || null);
      setName("");
      setRole("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      {members.length > 0 && (
        <div className="space-y-1.5">
          {members.map((m) => (
            <div
              key={m.id}
              className="flex items-center justify-between px-3 py-2 bg-zinc-800 rounded-lg"
            >
              <div className="flex-1 min-w-0">
                <span className="text-sm text-white">{m.name}</span>
                {m.role && (
                  <span className="text-xs text-zinc-500 ml-2">· {m.role}</span>
                )}
              </div>
              <button
                onClick={() => remove(m.id)}
                className="text-zinc-500 hover:text-red-400 p-1 transition-colors"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleAdd();
            }
          }}
          placeholder="이름"
          className="flex-1 bg-zinc-800 text-white rounded-lg px-3 py-2 text-sm placeholder:text-zinc-600 outline-none focus:ring-1 focus:ring-zinc-600"
        />
        <input
          type="text"
          value={role}
          onChange={(e) => setRole(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleAdd();
            }
          }}
          placeholder="직무 (선택)"
          className="flex-1 bg-zinc-800 text-white rounded-lg px-3 py-2 text-sm placeholder:text-zinc-600 outline-none focus:ring-1 focus:ring-zinc-600"
        />
        <button
          onClick={handleAdd}
          disabled={busy || !name.trim()}
          className="px-3 bg-zinc-700 hover:bg-zinc-600 disabled:opacity-30 rounded-lg text-zinc-300 hover:text-white transition-colors"
        >
          <Plus size={14} />
        </button>
      </div>
    </div>
  );
}

function MeetingTypesEditor() {
  const { types, add, remove } = useMeetingTypes();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const handleAdd = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      await add(trimmed);
      setName("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      {types.length > 0 && (
        <div className="space-y-1.5">
          {types.map((t) => (
            <div
              key={t.id}
              className="flex items-center justify-between px-3 py-2 bg-zinc-800 rounded-lg"
            >
              <span className="text-sm text-white">{t.name}</span>
              {t.is_builtin ? (
                <Lock size={12} className="text-zinc-600" />
              ) : (
                <button
                  onClick={() => remove(t.id)}
                  className="text-zinc-500 hover:text-red-400 p-1 transition-colors"
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleAdd();
            }
          }}
          placeholder="새 유형 이름 (예: 인터뷰)"
          className="flex-1 bg-zinc-800 text-white rounded-lg px-3 py-2 text-sm placeholder:text-zinc-600 outline-none focus:ring-1 focus:ring-zinc-600"
        />
        <button
          onClick={handleAdd}
          disabled={busy || !name.trim()}
          className="px-3 bg-zinc-700 hover:bg-zinc-600 disabled:opacity-30 rounded-lg text-zinc-300 hover:text-white transition-colors"
        >
          <Plus size={14} />
        </button>
      </div>
    </div>
  );
}
