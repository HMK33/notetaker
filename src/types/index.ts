export interface Meeting {
  id: string;
  title: string | null;
  recorded_at: string; // ISO datetime
  duration_sec: number;
  audio_path: string;
  memo: string | null;
  transcript: string | null;
  summary: MeetingSummary | null;
  notion_page_id: string | null;
  meeting_type: string | null;
  attendees: string[] | null;
  created_at: string;
}

export interface TeamMember {
  id: string;
  name: string;
  role: string | null;
  sort_order: number;
}

export interface MeetingType {
  id: string;
  name: string;
  sort_order: number;
  is_builtin: boolean;
}

export interface MeetingSetup {
  title: string | null;
  meeting_type: string | null;
  attendees: string[];
  diarize: boolean;
  audio_source: AudioSource;
}

export interface MeetingSummary {
  executive_summary: {
    purpose: string;
    main_conclusions: string[];
    key_agenda: string[];
  };
  key_decisions: string[];
  detailed_discussion: {
    topic: string;
    contents: string[];
    issues: string[];
  }[];
  action_items: ActionItem[];
  blocking_issues: string[];
  parking_lot: string[];
}

export interface ActionItem {
  task: string;
  owner?: string;
  due?: string;
}

export interface AudioDevice {
  name: string;
  is_default: boolean;
  is_blackhole: boolean;
}

export interface RecordingResult {
  audio_path: string;
  duration_sec: number;
  total_chunks: number;
}

export interface TranscriptResult {
  text: string;
  segments: TranscriptSegment[];
  language: string;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface PythonEnvStatus {
  installed: boolean;
  python_path: string;
  error?: string;
}

export type RecordingState = "idle" | "recording" | "paused" | "processing" | "done" | "error";
export type ProcessingStep = "saving" | "transcribing" | "summarizing" | null;
export type AudioSource = "microphone" | "system_and_mic";
export type WhisperModel =
  | "mlx-community/whisper-tiny-mlx"
  | "mlx-community/whisper-small-mlx"
  | "mlx-community/whisper-medium-mlx"
  | "mlx-community/whisper-large-v3-turbo"
  | "mlx-community/whisper-large-v3-mlx";

export type ClaudeModel = "" | "sonnet" | "opus" | "haiku";

export interface AppSettings {
  claude_path: string;
  claude_model: ClaudeModel;
  notion_api_key: string;
  notion_database_id: string;
  whisper_model: WhisperModel;
  recordings_path: string;
  audio_source: AudioSource;
  python_path: string;
  hf_token: string;
}
