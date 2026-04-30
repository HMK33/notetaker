# ttiro 설치 가이드

회의 녹음 → Whisper 전사 → Claude 요약 → Notion 저장을 자동화하는 macOS 데스크탑 앱.

## 시스템 요구사항

- macOS 13.0+ (Ventura 이상)
- Apple Silicon (M1/M2/M3/M4) — mlx-whisper가 Apple Silicon 전용
- Xcode Command Line Tools (`xcode-select --install`)

## 1단계: Python 환경 설정

mlx-whisper (로컬 음성 전사) 실행을 위한 Python 환경이 필요합니다.

```bash
# 프로젝트 루트에서
python3 -m venv .venv
source .venv/bin/activate
pip install mlx-whisper

# (선택) 화자 분리 기능을 쓸 경우
pip install pyannote.audio
```

화자 분리를 사용하려면 HuggingFace 토큰이 필요합니다:
1. https://huggingface.co/settings/tokens 에서 토큰 발급
2. https://huggingface.co/pyannote/speaker-diarization-3.1 에서 약관 동의
3. 앱 설정 → Whisper 설정 → HuggingFace 토큰에 입력

## 2단계: Claude CLI 설치

회의록 AI 요약에 Claude CLI를 사용합니다.

```bash
# npm으로 설치
npm install -g @anthropic-ai/claude-code

# 설치 확인
claude --version

# 최초 1회 로그인
claude
```

로그인 후 앱 설정에서 자동 감지됩니다.

## 3단계: 앱 설치 (DMG 배포)

`.dmg` 파일을 받은 경우:

1. DMG 열기 → `ttiro.app`을 `/Applications`으로 드래그
2. **중요**: 처음 실행 시 Gatekeeper가 차단합니다
   - Finder에서 `ttiro.app` 우클릭 → "열기" 클릭
   - "확인되지 않은 개발자" 경고에서 "열기" 한 번 더 클릭
3. 마이크 권한 팝업 → "허용"
4. (온라인 미팅 녹음 시) 화면 녹화 권한 팝업 → "허용"

## 3단계 (대체): 소스에서 빌드

```bash
# Rust 툴체인
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"

# 의존성 설치
npm install

# 개발 모드 실행
npm run tauri dev

# 릴리스 빌드
npm run tauri build
# 결과: src-tauri/target/release/bundle/macos/ttiro.app
```

빌드 후 `/Applications`에 복사:
```bash
cp -R src-tauri/target/release/bundle/macos/ttiro.app /Applications/
```

## 4단계: 앱 설정

앱 실행 후 우측 상단 설정(⚙) 버튼:

- **Claude CLI 경로**: 자동 감지됨. 안 되면 `which claude` 결과 입력
- **Python 경로**: 자동 감지됨. 안 되면 `.venv/bin/python` 경로 입력
- **Whisper 모델**: `large-v3` 권장 (최초 실행 시 ~3GB 다운로드)
- **Notion** (선택): API Key + Database ID 입력하면 요약 자동 저장

## 문제 해결

### 마이크 권한이 안 뜸 / 녹음 안 됨
```bash
tccutil reset Microphone com.gwonhyeogmin.notetaker
```
앱 재시작 후 권한 팝업 다시 뜸.

### 시스템 오디오(온라인 미팅) 캡처 안 됨
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
- Python 경로 확인: 설정 → "연결 확인" 버튼
- mlx-whisper 설치 확인: `.venv/bin/python -c "import mlx_whisper; print('ok')"`

## 기술 스택

- **프론트엔드**: React 19 + TypeScript + Tailwind CSS
- **백엔드**: Tauri 2 + Rust
- **오디오 캡처**: cpal (마이크) / ScreenCaptureKit via Swift FFI (시스템 오디오)
- **전사**: mlx-whisper (Apple Silicon 최적화 로컬 Whisper)
- **요약**: Claude CLI (`claude --print --output-format json`)
- **DB**: SQLite (tauri-plugin-sql)
- **외부 연동**: Notion API v1
