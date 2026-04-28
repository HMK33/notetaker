import { fetch } from "@tauri-apps/plugin-http";
import type { Meeting, MeetingSummary } from "../types";
import { format } from "date-fns";

// Notion rich_text 단일 항목은 2000자 제한. 그보다 길면 chunk로 나눠 보내야 함.
const NOTION_TEXT_CHUNK = 1900;

interface NotionRichText {
  type: "text";
  text: { content: string };
  annotations?: { bold?: boolean; italic?: boolean; code?: boolean };
}

type NotionBlock =
  | { object: "block"; type: "heading_1"; heading_1: { rich_text: NotionRichText[] } }
  | { object: "block"; type: "heading_2"; heading_2: { rich_text: NotionRichText[] } }
  | { object: "block"; type: "heading_3"; heading_3: { rich_text: NotionRichText[] } }
  | { object: "block"; type: "paragraph"; paragraph: { rich_text: NotionRichText[] } }
  | { object: "block"; type: "bulleted_list_item"; bulleted_list_item: { rich_text: NotionRichText[] } }
  | { object: "block"; type: "to_do"; to_do: { rich_text: NotionRichText[]; checked: boolean } }
  | { object: "block"; type: "divider"; divider: Record<string, never> }
  | { object: "block"; type: "toggle"; toggle: { rich_text: NotionRichText[]; children: NotionBlock[] } };

async function fetchWithRetry(
  url: string,
  options: Parameters<typeof fetch>[1],
  timeoutMs: number
) {
  let lastError: unknown = new Error("요청 실패");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await Promise.race([
        fetch(url, options),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`요청 시간 초과 (${timeoutMs / 1000}초)`)), timeoutMs)
        ),
      ]);
    } catch (e) {
      lastError = e;
      if (attempt === 0) await new Promise(r => setTimeout(r, 1500));
    }
  }
  throw lastError;
}

function chunkText(content: string): NotionRichText[] {
  if (!content) return [{ type: "text", text: { content: "" } }];
  const chunks: NotionRichText[] = [];
  for (let i = 0; i < content.length; i += NOTION_TEXT_CHUNK) {
    chunks.push({ type: "text", text: { content: content.slice(i, i + NOTION_TEXT_CHUNK) } });
  }
  return chunks;
}

function paragraph(text: string): NotionBlock {
  return { object: "block", type: "paragraph", paragraph: { rich_text: chunkText(text) } };
}

function heading2(text: string): NotionBlock {
  return { object: "block", type: "heading_2", heading_2: { rich_text: chunkText(text) } };
}

function heading3(text: string): NotionBlock {
  return { object: "block", type: "heading_3", heading_3: { rich_text: chunkText(text) } };
}

function bullet(text: string): NotionBlock {
  return { object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: chunkText(text) } };
}

function todo(text: string, checked = false): NotionBlock {
  return { object: "block", type: "to_do", to_do: { rich_text: chunkText(text), checked } };
}

function divider(): NotionBlock {
  return { object: "block", type: "divider", divider: {} };
}

function toggle(label: string, children: NotionBlock[]): NotionBlock {
  return { object: "block", type: "toggle", toggle: { rich_text: chunkText(label), children } };
}

function buildBlocks(meeting: Meeting): NotionBlock[] {
  const blocks: NotionBlock[] = [];
  const summary: MeetingSummary | null = meeting.summary;
  const recordedAt = format(new Date(meeting.recorded_at), "yyyy-MM-dd HH:mm");
  const durationMin = (meeting.duration_sec / 60).toFixed(1);

  const headerParts: string[] = [`📅 ${recordedAt}`, `⏱ ${durationMin}분`];
  if (meeting.meeting_type) headerParts.push(`🏷 ${meeting.meeting_type}`);
  blocks.push(paragraph(headerParts.join(" · ")));
  if (meeting.attendees && meeting.attendees.length > 0) {
    blocks.push(paragraph(`👥 참석자: ${meeting.attendees.join(", ")}`));
  }
  blocks.push(divider());

  if (meeting.memo) {
    blocks.push(heading2("📝 사용자 노트 (회의 중 작성)"));
    for (const line of meeting.memo.split(/\n+/).filter(Boolean)) {
      blocks.push(paragraph(line));
    }
  }

  if (summary) {
    blocks.push(heading2("📌 핵심 요약"));
    if (summary.executive_summary?.purpose) {
      blocks.push(paragraph(summary.executive_summary.purpose));
    }
    if (summary.executive_summary?.main_conclusions?.length) {
      blocks.push(heading3("주요 결론"));
      for (const c of summary.executive_summary.main_conclusions) blocks.push(bullet(c));
    }
    if (summary.executive_summary?.key_agenda?.length) {
      blocks.push(heading3("다룬 주제"));
      for (const a of summary.executive_summary.key_agenda) blocks.push(bullet(a));
    }

    if (summary.key_decisions?.length) {
      blocks.push(heading2("✅ 결정 사항"));
      for (const d of summary.key_decisions) blocks.push(bullet(d));
    }

    if (summary.action_items?.length) {
      blocks.push(heading2("🎯 액션 아이템"));
      for (const item of summary.action_items) {
        const owner = item.owner ? ` (담당: ${item.owner})` : "";
        const due = item.due ? ` [${item.due}]` : "";
        blocks.push(todo(`${item.task}${owner}${due}`));
      }
    }

    if (summary.detailed_discussion?.length) {
      blocks.push(heading2("💬 상세 논의"));
      for (const topic of summary.detailed_discussion) {
        blocks.push(heading3(topic.topic));
        if (topic.contents?.length) {
          for (const c of topic.contents) blocks.push(bullet(c));
        }
        if (topic.issues?.length) {
          for (const i of topic.issues) blocks.push(bullet(`⚠️ ${i}`));
        }
      }
    }

    if (summary.blocking_issues?.length) {
      blocks.push(heading2("🚧 블로커"));
      for (const b of summary.blocking_issues) blocks.push(bullet(b));
    }

    if (summary.parking_lot?.length) {
      blocks.push(heading2("🅿️ 보류 (Parking lot)"));
      for (const p of summary.parking_lot) blocks.push(bullet(p));
    }
  }

  if (meeting.transcript) {
    blocks.push(divider());
    // 전사 원문은 토글 안에 — 페이지가 길어지지 않도록.
    // Notion 토글 안 children은 100개 제한이라 paragraph로 분할.
    const transcriptParas = meeting.transcript
      .split(/\n+/)
      .filter(Boolean)
      .slice(0, 100)
      .map(paragraph);
    blocks.push(toggle("📄 전사 원문 (Whisper 자동)", transcriptParas));
  }

  return blocks;
}

async function findTitlePropertyName(
  apiKey: string,
  databaseId: string
): Promise<string> {
  const response = await fetchWithRetry(
    `https://api.notion.com/v1/databases/${databaseId}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Notion-Version": "2022-06-28",
      },
    },
    8000
  );
  if (!response.ok) {
    throw new Error(`Notion DB 조회 실패 (HTTP ${response.status})`);
  }
  const db = await response.json() as { properties: Record<string, { type: string }> };
  for (const [name, prop] of Object.entries(db.properties)) {
    if (prop.type === "title") return name;
  }
  throw new Error("DB에 title 속성을 찾을 수 없습니다.");
}

// Notion API는 한 번에 children 100개 제한 — 초과분은 별도 append 호출.
async function appendChildren(
  pageId: string,
  apiKey: string,
  blocks: NotionBlock[]
) {
  for (let i = 0; i < blocks.length; i += 100) {
    const slice = blocks.slice(i, i + 100);
    const response = await fetchWithRetry(
      `https://api.notion.com/v1/blocks/${pageId}/children`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ children: slice }),
      },
      15000
    );
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(
        `Notion 본문 저장 실패: ${(err as { message?: string }).message ?? `HTTP ${response.status}`}`
      );
    }
  }
}

export async function saveToNotion(
  meeting: Meeting,
  apiKey: string,
  databaseId: string
): Promise<string> {
  const title =
    meeting.title ?? format(new Date(meeting.recorded_at), "yyyy-MM-dd 미팅");
  const titleProp = await findTitlePropertyName(apiKey, databaseId);

  const allBlocks = buildBlocks(meeting);
  const firstBatch = allBlocks.slice(0, 100);
  const rest = allBlocks.slice(100);

  const body = {
    parent: { database_id: databaseId },
    properties: {
      [titleProp]: {
        title: [{ type: "text", text: { content: title } }],
      },
    },
    children: firstBatch,
  };

  const response = await fetchWithRetry("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  }, 15000);

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    const message =
      (err as { message?: string }).message ?? `HTTP ${response.status}`;
    throw new Error(`Notion API 오류: ${message}`);
  }

  const page = await response.json() as { id: string };

  if (rest.length > 0) {
    await appendChildren(page.id, apiKey, rest);
  }

  return page.id;
}
