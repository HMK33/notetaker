import Database from "@tauri-apps/plugin-sql";
import type { Meeting, MeetingSummary, TeamMember, MeetingType } from "../types";

let db: Database | null = null;

const MIGRATION_001 = `
  CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meetings (
    id TEXT PRIMARY KEY,
    title TEXT,
    recorded_at DATETIME NOT NULL,
    duration_sec INTEGER NOT NULL DEFAULT 0,
    audio_path TEXT NOT NULL,
    memo TEXT,
    transcript TEXT,
    summary TEXT,
    notion_page_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_meetings_recorded_at ON meetings(recorded_at DESC);
`;

const MIGRATION_002 = `
  CREATE TABLE IF NOT EXISTS team_members (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS meeting_types (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_builtin INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  ALTER TABLE meetings ADD COLUMN meeting_type TEXT;
  ALTER TABLE meetings ADD COLUMN attendees TEXT;
`;

export async function getDb(): Promise<Database> {
  if (db) return db;
  db = await Database.load("sqlite:notetaker.db");
  await runMigrations(db);
  return db;
}

async function runMigrations(database: Database): Promise<void> {
  await database.execute(
    "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)"
  );

  const rows = await database.select<{ version: number }[]>(
    "SELECT version FROM schema_version ORDER BY version DESC LIMIT 1"
  );
  const currentVersion = rows[0]?.version ?? 0;

  if (currentVersion < 1) {
    await database.execute(MIGRATION_001);
    await database.execute("INSERT OR IGNORE INTO schema_version VALUES (1)");
  }
  if (currentVersion < 2) {
    await database.execute(MIGRATION_002);
    // 기본 미팅 유형 시드 (builtin이라 삭제는 막을 예정)
    await database.execute(
      `INSERT OR IGNORE INTO meeting_types (id, name, sort_order, is_builtin) VALUES
       ('builtin_internal', '내부미팅', 0, 1),
       ('builtin_external', '외부미팅', 1, 1)`
    );
    await database.execute("INSERT OR IGNORE INTO schema_version VALUES (2)");
  }
}

export async function saveMeeting(meeting: Omit<Meeting, "created_at">): Promise<void> {
  const database = await getDb();
  const summaryJson = meeting.summary ? JSON.stringify(meeting.summary) : null;
  const attendeesJson = meeting.attendees ? JSON.stringify(meeting.attendees) : null;

  await database.execute(
    `INSERT INTO meetings (id, title, recorded_at, duration_sec, audio_path, memo, transcript, summary, notion_page_id, meeting_type, attendees)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      meeting.id,
      meeting.title,
      meeting.recorded_at,
      meeting.duration_sec,
      meeting.audio_path,
      meeting.memo,
      meeting.transcript,
      summaryJson,
      meeting.notion_page_id,
      meeting.meeting_type ?? null,
      attendeesJson,
    ]
  );
}

export async function updateMeetingTranscript(id: string, transcript: string): Promise<void> {
  const database = await getDb();
  await database.execute("UPDATE meetings SET transcript = $1 WHERE id = $2", [transcript, id]);
}

export async function updateMeetingSummary(id: string, summary: MeetingSummary): Promise<void> {
  const database = await getDb();
  await database.execute("UPDATE meetings SET summary = $1 WHERE id = $2", [
    JSON.stringify(summary),
    id,
  ]);
}

export async function updateMeetingTitle(id: string, title: string): Promise<void> {
  const database = await getDb();
  await database.execute("UPDATE meetings SET title = $1 WHERE id = $2", [title, id]);
}

export async function updateNotionPageId(id: string, notionPageId: string): Promise<void> {
  const database = await getDb();
  await database.execute("UPDATE meetings SET notion_page_id = $1 WHERE id = $2", [
    notionPageId,
    id,
  ]);
}

type MeetingRow = Omit<Meeting, "summary" | "attendees"> & {
  summary: string | null;
  attendees: string | null;
};

function rowToMeeting(row: MeetingRow): Meeting {
  return {
    ...row,
    summary: row.summary ? (JSON.parse(row.summary) as MeetingSummary) : null,
    attendees: row.attendees ? (JSON.parse(row.attendees) as string[]) : null,
  };
}

export async function getMeetings(): Promise<Meeting[]> {
  const database = await getDb();
  const rows = await database.select<MeetingRow[]>(
    "SELECT * FROM meetings ORDER BY recorded_at DESC"
  );
  return rows.map(rowToMeeting);
}

export async function getMeetingById(id: string): Promise<Meeting | null> {
  const database = await getDb();
  const rows = await database.select<MeetingRow[]>(
    "SELECT * FROM meetings WHERE id = $1",
    [id]
  );
  if (rows.length === 0) return null;
  return rowToMeeting(rows[0]);
}

// ── 팀원 관리 ──
export async function getTeamMembers(): Promise<TeamMember[]> {
  const database = await getDb();
  return database.select<TeamMember[]>(
    "SELECT id, name, role, sort_order FROM team_members ORDER BY sort_order ASC, created_at ASC"
  );
}

export async function addTeamMember(name: string, role: string | null): Promise<TeamMember> {
  const database = await getDb();
  const id = crypto.randomUUID();
  const sortOrder = Date.now();
  await database.execute(
    "INSERT INTO team_members (id, name, role, sort_order) VALUES ($1, $2, $3, $4)",
    [id, name, role, sortOrder]
  );
  return { id, name, role, sort_order: sortOrder };
}

export async function updateTeamMember(
  id: string,
  name: string,
  role: string | null
): Promise<void> {
  const database = await getDb();
  await database.execute(
    "UPDATE team_members SET name = $1, role = $2 WHERE id = $3",
    [name, role, id]
  );
}

export async function deleteTeamMember(id: string): Promise<void> {
  const database = await getDb();
  await database.execute("DELETE FROM team_members WHERE id = $1", [id]);
}

// ── 미팅 유형 관리 ──
export async function getMeetingTypes(): Promise<MeetingType[]> {
  const database = await getDb();
  const rows = await database.select<
    { id: string; name: string; sort_order: number; is_builtin: number }[]
  >(
    "SELECT id, name, sort_order, is_builtin FROM meeting_types ORDER BY sort_order ASC, created_at ASC"
  );
  return rows.map((r) => ({ ...r, is_builtin: r.is_builtin === 1 }));
}

export async function addMeetingType(name: string): Promise<MeetingType> {
  const database = await getDb();
  const id = crypto.randomUUID();
  const sortOrder = Date.now();
  await database.execute(
    "INSERT INTO meeting_types (id, name, sort_order, is_builtin) VALUES ($1, $2, $3, 0)",
    [id, name, sortOrder]
  );
  return { id, name, sort_order: sortOrder, is_builtin: false };
}

export async function deleteMeetingType(id: string): Promise<void> {
  const database = await getDb();
  // builtin은 삭제 불가 — 안전망으로 SQL에서도 한 번 더 차단
  await database.execute(
    "DELETE FROM meeting_types WHERE id = $1 AND is_builtin = 0",
    [id]
  );
}

export async function deleteMeeting(id: string): Promise<void> {
  const database = await getDb();
  await database.execute("DELETE FROM meetings WHERE id = $1", [id]);
}

export async function getRecordingsTotalSize(): Promise<string> {
  const database = await getDb();
  const rows = await database.select<{ audio_path: string }[]>(
    "SELECT audio_path FROM meetings WHERE audio_path IS NOT NULL"
  );
  return JSON.stringify(rows.map((r) => r.audio_path));
}
