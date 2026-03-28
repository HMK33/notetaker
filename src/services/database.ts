import Database from "@tauri-apps/plugin-sql";
import type { Meeting, MeetingSummary } from "../types";

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
}

export async function saveMeeting(meeting: Omit<Meeting, "created_at">): Promise<void> {
  const database = await getDb();
  const summaryJson = meeting.summary ? JSON.stringify(meeting.summary) : null;

  await database.execute(
    `INSERT INTO meetings (id, title, recorded_at, duration_sec, audio_path, memo, transcript, summary, notion_page_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
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

export async function getMeetings(): Promise<Meeting[]> {
  const database = await getDb();
  const rows = await database.select<
    (Omit<Meeting, "summary"> & { summary: string | null })[]
  >("SELECT * FROM meetings ORDER BY recorded_at DESC");

  return rows.map((row) => ({
    ...row,
    summary: row.summary ? (JSON.parse(row.summary) as MeetingSummary) : null,
  }));
}

export async function getMeetingById(id: string): Promise<Meeting | null> {
  const database = await getDb();
  const rows = await database.select<
    (Omit<Meeting, "summary"> & { summary: string | null })[]
  >("SELECT * FROM meetings WHERE id = $1", [id]);

  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    ...row,
    summary: row.summary ? (JSON.parse(row.summary) as MeetingSummary) : null,
  };
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
