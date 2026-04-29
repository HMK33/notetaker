// 빌드 시점에 baked in된 환경 변수 (Vite import.meta.env).
// 사용자 설정값이 우선이고, 비어있으면 env 값을 fallback으로 사용.

const ENV_HF_TOKEN = ((import.meta.env.VITE_HF_TOKEN as string | undefined) ?? "").trim();

/**
 * 사용자 설정 토큰 → env 토큰 → 빈 문자열 순으로 반환.
 * `useRecording`/`MeetingSetupView` 양쪽에서 같은 우선순위 보장.
 */
export function effectiveHfToken(settingsToken: string | undefined | null): string {
  const fromSettings = (settingsToken ?? "").trim();
  return fromSettings || ENV_HF_TOKEN;
}
