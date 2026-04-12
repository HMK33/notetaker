import { invoke } from "@tauri-apps/api/core";
import type { MeetingSummary } from "../types";

const SYSTEM_PROMPT = `당신은 꼼꼼하고 완벽을 기하는 '수석 비즈니스 회의 서기(Chief Meeting Secretary)'입니다.
당신의 최우선 목표는 화자가 구분되지 않은 날것(Raw)의 전사 텍스트에서, 단 하나의 디테일이나 팩트도 누락되지 않도록 최대한 자세하게 텍스트를 정리하는 것입니다.

Rules:
1. 화자 특정 금지: 누가 말했는지 억지로 유추하거나 역할/이름을 지어내지 마세요. 화자가 누구인지보다는 "어떤 제안이 나왔고, 어떤 반론/우려가 있었으며, 어떻게 합의되었는지" 내용 자체의 흐름에만 100% 집중하세요.
2. 사실 위주 상세 기록 (누락 방지): 사소해 보이는 의견, 제안, 우려사항도 빠짐없이 기록하세요. 지나치게 축약하지 말고 모든 팩트를 구체적인 불릿 포인트로 살리세요.
3. 주제 중심(Topic-Centric) 재배치: 시간순 나열이 아니라 "주제 - 쟁점 - 결론"의 포맷으로 내용을 정리하세요. 대화가 뒤섞여 있더라도 같은 안건에 대한 논의는 시공간을 초월해 한 묶음으로 정리해야 합니다.
4. 사용자 메모([사용자 직접 작성]) 반영: 사용자가 입력한 메모에 주요 안건이나 핵심 키워드가 있다면 이를 바탕으로 전사 텍스트의 맥락을 해석하세요.

반드시 아래 JSON 형식으로만 응답하세요. 다른 텍스트 없이 JSON만 출력합니다.

{
  "executive_summary": {
    "purpose": "이 회의가 열린 주된 이유 요약",
    "main_conclusions": ["도출된 모든 주요 결론들"],
    "key_agenda": ["다뤄진 자세한 주제 리스트 (누락 주의)"]
  },
  "key_decisions": ["[결정] 결정된 내용 (어떤 배경/이유로 도출되었는지, 제안과 반박 과정까지 구체적으로 포함)"],
  "detailed_discussion": [
    {
      "topic": "주제명",
      "contents": ["해당 주제에 대해 오고 간 모든 논의 내용, 제안, 우려사항들을 누락 없이 상세히 기록 (누가 주장했는지 억지로 적지 말고, 의견 자체만 생생하게 기록)"],
      "issues": ["제기된 쟁점, 의견 충돌 혹은 리스크 (세세하게 모두 기록)"]
    }
  ],
  "action_items": [
    {"task": "작업 내용 (최대한 구체적으로)", "owner": "담당자 (대화 중 명확하게 언급된 경우에만 기재, 불확실하면 빈 문자열)", "due": "마감기한 (없으면 '미정')"}
  ],
  "blocking_issues": ["프로젝트 진행을 막는 요소나 제기된 리스크 (없으면 ['특이사항 없음'])"],
  "parking_lot": ["결론이 나지 않거나 추후 논의하기로 한 안건 (없으면 빈 배열)"]
}`;

const MAX_TRANSCRIPT_CHARS = 80000; // ~20k tokens

interface ClaudeCliOutput {
  result: string;
  is_error: boolean;
}

export async function summarizeMeeting(
  transcript: string,
  memo: string | null,
  claudePath?: string,
): Promise<MeetingSummary> {
  const truncatedTranscript =
    transcript.length > MAX_TRANSCRIPT_CHARS
      ? transcript.slice(0, MAX_TRANSCRIPT_CHARS) + "\n\n[전사본이 너무 길어 일부 생략됨]"
      : transcript;

  const prompt = `${SYSTEM_PROMPT}\n\n[전사 내용]\n${truncatedTranscript}\n\n[사용자 직접 작성]\n${memo ?? "없음"}`;

  const stdout = await invoke<string>("run_claude_summary", {
    prompt,
    claudePath: claudePath || undefined,
  });

  const cliOutput = JSON.parse(stdout) as ClaudeCliOutput;
  if (cliOutput.is_error) {
    throw new Error(`Claude 오류: ${cliOutput.result}`);
  }

  const resultText = cliOutput.result;

  try {
    return JSON.parse(resultText) as MeetingSummary;
  } catch {
    const match = resultText.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]) as MeetingSummary;
    throw new Error("요약 결과를 파싱할 수 없습니다. Claude 응답 형식 오류");
  }
}
