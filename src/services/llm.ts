import { invoke } from "@tauri-apps/api/core";
import type { MeetingSummary } from "../types";

const SYSTEM_PROMPT = `당신은 꼼꼼하고 완벽을 기하는 '수석 비즈니스 회의 서기(Chief Meeting Secretary)'입니다.
당신의 최우선 목표는 사용자가 회의 중 직접 작성한 노트와 자동 전사 텍스트를 결합하여, 단 하나의 디테일이나 팩트도 누락되지 않는 회의 요약을 만드는 것입니다.

두 입력의 신뢰도가 다릅니다:
- [사용자 노트]: 사람이 회의 중 실시간으로 직접 적은 내용. **사실로 간주하고 최우선 신뢰**합니다.
- [전사 내용]: Whisper 자동 전사. 디테일·맥락 보충용. 노트와 충돌하면 노트가 옳습니다.

Rules:
1. 사용자 노트 우선 (Source of Truth): [사용자 노트]에 적힌 결정·액션·숫자·고유명사는 그대로 결과에 반영하세요. 전사가 다르게 들렸어도 노트를 우선합니다.
2. 전사로 디테일 보충: 노트에 없는 논의 흐름·반론·세부 발언은 전사에서 가져와 풍부하게 채우세요.
3. 화자 특정 금지: 누가 말했는지 억지로 유추하거나 역할/이름을 지어내지 마세요. "어떤 제안이 나왔고, 어떤 반론/우려가 있었으며, 어떻게 합의되었는지" 내용 자체의 흐름에 집중하세요. (노트에 담당자가 명시된 경우는 예외 — 그대로 사용)
4. 사실 위주 상세 기록 (누락 방지): 사소해 보이는 의견, 제안, 우려사항도 빠짐없이 기록하세요. 지나치게 축약하지 말고 모든 팩트를 구체적인 불릿 포인트로 살리세요.
5. 주제 중심(Topic-Centric) 재배치: 시간순 나열이 아니라 "주제 - 쟁점 - 결론"의 포맷으로 정리하세요. 대화가 뒤섞여 있더라도 같은 안건에 대한 논의는 한 묶음으로 모으세요.
6. 단락 = 화자 turn 가능성: [전사 내용]에서 빈 줄(단락)로 분리된 부분은 화자가 바뀌었을 가능성이 있는 지점입니다 (자동 분리 결과라 100%는 아님). turn 흐름을 이해하는 데 활용하되, 단락 = 특정 인물이라는 강한 단정은 금지. 라벨도 부여하지 마세요.

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

const MAX_TRANSCRIPT_CHARS = 400000; // ~100k tokens

interface ClaudeCliOutput {
  result: string;
  is_error: boolean;
}

export interface SummaryContext {
  meeting_type: string | null;
  attendees: string[] | null;
}

export async function summarizeMeeting(
  transcript: string,
  memo: string | null,
  context: SummaryContext,
  claudePath?: string,
): Promise<MeetingSummary> {
  const truncatedTranscript =
    transcript.length > MAX_TRANSCRIPT_CHARS
      ? transcript.slice(0, MAX_TRANSCRIPT_CHARS) + "\n\n[전사본이 너무 길어 일부 생략됨]"
      : transcript;

  const meetingTypeLine = context.meeting_type
    ? `[미팅 유형] ${context.meeting_type}`
    : "[미팅 유형] 지정 안 됨";

  const attendeesLine = context.attendees && context.attendees.length > 0
    ? `[참석자]\n${context.attendees.map((a) => `- ${a}`).join("\n")}\n\n참고: 발언자가 명확히 노트에 기록되지 않은 경우라도, 참석자의 직무·역할에 비추어 발언 내용이 누구의 관점일 가능성이 높은지 자연스러운 attribution이 가능하면 활용하세요. 단, 강하게 단정하지 말고 "~의 관점에서" 같은 완곡한 표현 사용. 명확하지 않으면 화자 미기재.`
    : "[참석자] 명시되지 않음";

  const prompt = `${SYSTEM_PROMPT}\n\n${meetingTypeLine}\n\n${attendeesLine}\n\n[사용자 노트]\n${memo ?? "없음"}\n\n[전사 내용]\n${truncatedTranscript}`;

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
