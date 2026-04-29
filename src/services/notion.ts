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

type SelectableType = "select" | "status" | "multi_select";

interface NotionProperty {
  type: string;
  select?: { options: Array<{ name: string }> };
  status?: { options: Array<{ name: string }> };
  multi_select?: { options: Array<{ name: string }> };
}

interface DbSchema {
  titleProperty: string;
  dateProperties: string[];
  numberProperties: string[];
  richTextProperties: string[];
  selectables: Array<{
    name: string;
    type: SelectableType;
    options: string[];
  }>;
}

async function fetchDbSchema(apiKey: string, databaseId: string): Promise<DbSchema> {
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
  const db = await response.json() as { properties: Record<string, NotionProperty> };

  let titleProperty: string | null = null;
  const selectables: DbSchema["selectables"] = [];
  const dateProperties: string[] = [];
  const numberProperties: string[] = [];
  const richTextProperties: string[] = [];
  for (const [name, prop] of Object.entries(db.properties)) {
    if (prop.type === "title") {
      titleProperty = name;
    } else if (prop.type === "date") {
      dateProperties.push(name);
    } else if (prop.type === "number") {
      numberProperties.push(name);
    } else if (prop.type === "rich_text") {
      richTextProperties.push(name);
    } else if (prop.type === "select" && prop.select) {
      selectables.push({ name, type: "select", options: prop.select.options.map((o) => o.name) });
    } else if (prop.type === "status" && prop.status) {
      selectables.push({ name, type: "status", options: prop.status.options.map((o) => o.name) });
    } else if (prop.type === "multi_select" && prop.multi_select) {
      selectables.push({ name, type: "multi_select", options: prop.multi_select.options.map((o) => o.name) });
    }
  }
  if (!titleProperty) {
    throw new Error("DB에 title 속성을 찾을 수 없습니다.");
  }
  return { titleProperty, dateProperties, numberProperties, richTextProperties, selectables };
}

// 공백·대소문자 차이 흡수 ("내부미팅" ↔ "내부 미팅" 등 매칭)
function normalizeName(s: string): string {
  return s.replace(/\s+/g, "").toLowerCase();
}

/**
 * 미팅 유형 문자열과 매칭되는 select/status/multi_select 프로퍼티를 찾는다.
 * DB의 모든 후보 프로퍼티를 순회하며 옵션 이름을 비교 (공백 무시).
 * 첫 번째 매치 반환. 없으면 null.
 */
function findTypeMatch(
  schema: DbSchema,
  meetingType: string
): { propertyName: string; type: SelectableType; optionName: string } | null {
  const target = normalizeName(meetingType);
  for (const prop of schema.selectables) {
    for (const option of prop.options) {
      if (normalizeName(option) === target) {
        return { propertyName: prop.name, type: prop.type, optionName: option };
      }
    }
  }
  return null;
}

function selectablePropertyValue(type: SelectableType, optionName: string) {
  if (type === "select") return { select: { name: optionName } };
  if (type === "status") return { status: { name: optionName } };
  return { multi_select: [{ name: optionName }] };
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
  const schema = await fetchDbSchema(apiKey, databaseId);

  const properties: Record<string, unknown> = {
    [schema.titleProperty]: {
      title: [{ type: "text", text: { content: title } }],
    },
  };

  // Date 속성: 첫 번째 date-type 프로퍼티에 회의 날짜 자동 입력
  if (schema.dateProperties.length > 0) {
    properties[schema.dateProperties[0]] = {
      date: { start: meeting.recorded_at },
    };
  }

  // Number 속성 중 이름이 길이/duration 류면 분 단위 시간 입력
  for (const name of schema.numberProperties) {
    const lower = name.toLowerCase();
    if (/길이|시간|duration|length|minutes/.test(lower)) {
      properties[name] = { number: parseFloat((meeting.duration_sec / 60).toFixed(1)) };
      break;
    }
  }

  // 미팅 유형 자동 매칭:
  //  1순위: DB의 select/status/multi_select 프로퍼티 옵션 이름과 일치 (공백/대소문자 무시)
  //  2순위: 1순위에서 못 찾으면, "구분/유형/type/category" 같은 이름의 rich_text 프로퍼티에 텍스트로 입력
  if (meeting.meeting_type) {
    const match = findTypeMatch(schema, meeting.meeting_type);
    if (match) {
      properties[match.propertyName] = selectablePropertyValue(match.type, match.optionName);
    } else {
      const fallback = schema.richTextProperties.find((n) =>
        /구분|유형|type|category/i.test(n)
      );
      if (fallback) {
        properties[fallback] = { rich_text: [{ type: "text", text: { content: meeting.meeting_type } }] };
      }
    }
  }

  const allBlocks = buildBlocks(meeting);
  const firstBatch = allBlocks.slice(0, 100);
  const rest = allBlocks.slice(100);

  const body = {
    parent: { database_id: databaseId },
    properties,
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
