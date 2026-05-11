# ttiro 설치 가이드

회의 녹음 → Whisper 전사 → Claude 요약 → Notion 저장을 자동화하는 macOS 데스크탑 앱.

> **이 문서를 읽는 사람은 두 종류입니다.**
> - **DMG로 설치하는 팀원** → 「A. DMG로 설치」 만 따라가세요.
> - **소스에서 빌드/배포하는 사람** → 「B. 소스에서 빌드」 를 따라가세요.

## 시스템 요구사항

- macOS 13.0+ (Ventura 이상)
- Apple Silicon (M1/M2/M3/M4) — mlx-whisper가 Apple Silicon 전용
- (빌드 시) Xcode Command Line Tools (`xcode-select --install`)

---

## A. DMG로 설치 (수령자용)

DMG를 받았다면 이 섹션만 따라가면 됩니다. 빌드 도구는 필요 없지만 **Python + Claude CLI 두 가지는 본인 Mac에 설치돼 있어야 합니다** (앱이 외부 프로세스로 호출하기 때문).

### A-1. Python 환경 (mlx-whisper)

전사는 로컬 Python의 mlx-whisper로 돌아갑니다. 앱 안에는 동봉돼 있지 않습니다.

```bash
# 본인 홈 디렉터리 어딘가에서 — 위치는 자유
mkdir -p ~/ttiro && cd ~/ttiro
python3 -m venv .venv
source .venv/bin/activate
pip install mlx-whisper

# (선택) 화자 분리도 쓰려면
pip install pyannote.audio
```

설치 후 앱 설정 → "Python 경로" 에 `~/ttiro/.venv/bin/python` 입력 (또는 비워두면 자동 탐색).

화자 분리(pyannote)를 쓸 경우 HuggingFace 토큰까지:
1. https://huggingface.co/settings/tokens 에서 **Read 권한** 토큰 발급
2. https://huggingface.co/pyannote/speaker-diarization-3.1 에서 모델 약관 동의 (필수)
3. 앱 설정 → Whisper 설정 → HuggingFace 토큰 입력
4. 토큰이 비어있으면 새 미팅 화면에서 화자 분리 옵션이 자동 비활성화됩니다.

### A-2. Claude CLI 설치

요약은 Claude CLI 서브프로세스로 돌아갑니다.

```bash
npm install -g @anthropic-ai/claude-code
claude --version   # 설치 확인
```

npm이 없다면 https://nodejs.org 에서 Node.js LTS 먼저.

### A-3. DMG 설치

1. DMG 열기 → `ttiro.app`을 `/Applications`으로 드래그
2. **첫 실행은 Gatekeeper가 막습니다.** Finder에서 `ttiro.app` 우클릭 → "열기" → "확인되지 않은 개발자" 경고에서 "열기" 한 번 더.
3. 첫 실행 시 권한 팝업이 순서대로 뜹니다:
   - **마이크 권한** → "허용" (녹음용)
   - **화면 녹화 권한** (온라인 미팅 모드 선택 시) → "허용" (시스템 오디오 캡처용, 화면 영상은 안 씀)
   - **클립보드 권한** (요약 결과 복사 시) → "허용"

### A-4. 앱 안에서 Claude 로그인

설치 직후 한 번만:
1. 앱 우측 상단 ⚙ 설정 열기
2. "AI 설정" → **Claude 로그인** 버튼 → 자동으로 터미널이 열리고 OAuth 시작
3. 브라우저 인증 완료 → 터미널 창 닫아도 됨

> 앱은 매 요약 직전에 로그인 상태를 자동 점검합니다. 풀려있으면 5분 타임아웃 기다리지 않고 즉시 안내가 나옵니다.

### A-5. 나머지 설정

⚙ 설정에서:
- **Claude CLI 경로**: 자동 감지. 안 되면 `which claude` 결과 입력
- **Python 경로**: 자동 감지. 안 되면 A-1에서 만든 `.venv/bin/python` 경로 입력
- **Whisper 모델**: `large-v3` 권장 (최초 전사 시 ~3GB 자동 다운로드)
- **Notion** (선택): Notion API Key + Database ID 입력 시 요약 자동 저장

---

## B. 소스에서 빌드 (배포자용)

DMG를 만들거나 직접 개발할 때.

### B-1. 빌드 환경

```bash
# Rust 툴체인
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"

# Node.js (npm 포함) — https://nodejs.org

# 프로젝트 의존성
cd notetaker
npm install
```

### B-2. Python (개발 시 동일하게 필요)

A-1과 동일. 프로젝트 루트에 `.venv` 두면 앱이 우선 탐색합니다.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install mlx-whisper pyannote.audio
```

### B-3. 빌드

```bash
# 개발 모드
npm run tauri dev

# 릴리스 빌드
npm run tauri build
# 결과물: src-tauri/target/release/bundle/macos/ttiro.app
#         src-tauri/target/release/bundle/dmg/ttiro_*.dmg
```

### B-4. DMG 배포 시 주의

- 받는 사람은 **A 섹션 전체를 따라가야** 함 (Python + Claude CLI 본인 Mac에 설치)
- 코드 서명은 현재 adhoc — 받는 사람마다 Gatekeeper 우회(A-3 2번) 한 번 필요
- 빌드 머신에서 cwd `.venv` 자동 탐색이 동작하므로 빌드 머신 본인은 따로 경로 입력 불필요, 다른 Mac에서는 A-5의 Python 경로 설정 필요

---

## 문제 해결

### 마이크 권한이 안 뜸 / 녹음 안 됨
```bash
tccutil reset Microphone com.gwonhyeogmin.notetaker
```
앱 재시작 후 권한 팝업 다시 뜸.

### 시스템 오디오(온라인 미팅) 캡처 안 됨
새 미팅 화면에서 "온라인" 모드 선택 시, 화면 녹화 권한이 없으면 경고와 함께
"시스템 설정 열기" 버튼이 표시됩니다. 그 버튼으로 설정에서 ttiro 허용 후 앱 재시작.

권한이 꼬였을 땐:
```bash
tccutil reset ScreenCapture com.gwonhyeogmin.notetaker
```
앱 재시작 → 시스템 설정 → 개인정보 보호 → 화면 녹화에서 ttiro 허용.

### 소스에서 반복 빌드 시 권한 풀림
Adhoc 서명이 빌드마다 바뀌어서 TCC 권한이 초기화됩니다.
빌드 후 매번 위 `tccutil reset` 명령 실행 필요.

### "확인되지 않은 개발자" 경고가 계속 뜸
```bash
xattr -cr /Applications/ttiro.app
```

### Whisper 전사 실패
- Python 경로 확인: 설정 → "연결 확인" 버튼 (mlx-whisper 미설치 시 친절 메시지로 설치 명령 안내됨)
- mlx-whisper 설치 확인: `.venv/bin/python -c "import mlx_whisper; print('ok')"`
- 자동 탐색 우선순위: 앱 리소스 동봉 .venv → 개발 cwd .venv → /opt/homebrew/bin/python3 → /usr/local/bin/python3 → /usr/bin/python3

### Claude 요약 실패
- "Claude CLI 로그인이 필요합니다" 안내가 뜨면 설정 → "Claude 로그인" 버튼.
- 로그인은 정상인데 응답 없음/타임아웃 → 인터넷 연결, Claude 모델 설정(설정 → AI 설정 → Claude 모델), CLI 경로 확인.

## 기술 스택

- **프론트엔드**: React 19 + TypeScript + Tailwind CSS
- **백엔드**: Tauri 2 + Rust
- **오디오 캡처**: cpal (마이크) / ScreenCaptureKit via Swift FFI (시스템 오디오)
- **전사**: mlx-whisper (Apple Silicon 최적화 로컬 Whisper)
- **요약**: Claude CLI (`claude --print --output-format json`)
- **DB**: SQLite (tauri-plugin-sql)
- **외부 연동**: Notion API v1
