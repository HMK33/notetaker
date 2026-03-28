import { fetch } from "@tauri-apps/plugin-http";
import type { Meeting } from "../types";
import { format } from "date-fns";

interface NotionRichText {
  type: "text";
  text: { content: string };
}

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

function richText(content: string): NotionRichText[] {
  const truncated = content.slice(0, 2000);
  return [{ type: "text", text: { content: truncated } }];
}

function formatActionItems(meeting: Meeting): string {
  if (!meeting.summary?.action_items?.length) return "없음";
  return meeting.summary.action_items
    .map((item) => {
      let line = `- ${item.task}`;
      if (item.owner) line += ` (담당: ${item.owner})`;
      if (item.due) line += ` [${item.due}]`;
      return line;
    })
    .join("\n");
}

export async function saveToNotion(
  meeting: Meeting,
  apiKey: string,
  databaseId: string
): Promise<string> {
  const title =
    meeting.title ?? format(new Date(meeting.recorded_at), "yyyy-MM-dd 미팅");
  const durationMin = (meeting.duration_sec / 60).toFixed(1);
  const executiveSummary = meeting.summary?.executive_summary.purpose ?? "";
  const actionItemsText = formatActionItems(meeting);
  const transcriptPreview = (meeting.transcript ?? "").slice(0, 2000);

  const body = {
    parent: { database_id: databaseId },
    properties: {
      제목: {
        title: [{ type: "text", text: { content: title } }],
      },
      날짜: {
        date: { start: meeting.recorded_at },
      },
      길이: {
        number: parseFloat(durationMin),
      },
      요약: {
        rich_text: richText(executiveSummary),
      },
      액션아이템: {
        rich_text: richText(actionItemsText),
      },
      전사원문: {
        rich_text: richText(transcriptPreview),
      },
      녹음파일경로: {
        rich_text: richText(meeting.audio_path),
      },
    },
  };

  const response = await fetchWithRetry("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  }, 10000);

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    const message =
      (err as { message?: string }).message ?? `HTTP ${response.status}`;
    throw new Error(`Notion API 오류: ${message}`);
  }

  const page = await response.json() as { id: string };
  return page.id;
}
