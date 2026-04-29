#!/usr/bin/env python3
"""
mlx-whisper 전사 스크립트
사용법 (단일):  python3 transcribe.py <audio_path> [model_name] [initial_prompt]
사용법 (서버):  python3 transcribe.py --server [model_name] [--diarize-token <hf_token>]
  stdin  → {"audio_path": "...", "initial_prompt": "...", "diarize": true|false}\n
  stdout ← {"text": "...", "segments": [...], "language": "..."}\n  또는  {"error": "..."}\n

화자 분리(diarize=true)가 켜지면 pyannote.audio로 turn boundary만 추출해서
Whisper segment 사이에 \n\n 단락 구분자를 삽입한다. 화자 라벨(SPEAKER_xx)은 사용하지 않음.
"""
import sys
import json
import os
import re
import contextlib

_original_stderr = sys.stderr


@contextlib.contextmanager
def silenced_stderr():
    """mlx_whisper progress bar deadlock 방지를 위해 stderr을 일시적으로 /dev/null로 리다이렉트.
    파일 핸들이 with 종료 시 정상 닫힘."""
    devnull = open(os.devnull, "w")
    saved = sys.stderr
    sys.stderr = devnull
    try:
        yield
    finally:
        sys.stderr = saved
        devnull.close()

# 다이어라이제이션 파이프라인 캐시 — 한 번 로드 후 재사용
_diar_pipeline = None
_diar_token = None


def squash_repetitions(text: str) -> str:
    pattern = r"(.+?)(?:[\s,]+\1){4,}"
    return re.sub(pattern, r"\1", text)


def _mask_token(text: str, token: str) -> str:
    """예외 메시지·로그에 토큰이 노출되지 않도록 치환."""
    if token and token in text:
        return text.replace(token, "<HF_TOKEN_REDACTED>")
    return text


def get_diar_pipeline(hf_token: str):
    """pyannote 파이프라인 lazy load. 토큰이 바뀌면 재로드.
    실패 시 토큰 마스킹된 RuntimeError를 던짐."""
    global _diar_pipeline, _diar_token
    if _diar_pipeline is not None and _diar_token == hf_token:
        return _diar_pipeline
    try:
        from pyannote.audio import Pipeline
    except ImportError:
        raise RuntimeError("pyannote.audio가 설치되지 않았습니다. pip install pyannote.audio")

    try:
        pipeline = Pipeline.from_pretrained(
            "pyannote/speaker-diarization-3.1",
            use_auth_token=hf_token,
        )
    except Exception as e:
        # 토큰이 잘못됐거나 약관 미동의 시 라이브러리가 토큰을 메시지에 포함할 수 있음
        raise RuntimeError(
            "pyannote 파이프라인 로드 실패: "
            + _mask_token(str(e), hf_token)
            + "\nHF 토큰 유효성 + https://huggingface.co/pyannote/speaker-diarization-3.1 약관 동의 확인하세요."
        )
    if pipeline is None:
        raise RuntimeError(
            "pyannote 파이프라인 로드 실패. HF 토큰이 유효한지, "
            "https://huggingface.co/pyannote/speaker-diarization-3.1 에서 약관 동의했는지 확인하세요."
        )
    _diar_pipeline = pipeline
    _diar_token = hf_token
    return _diar_pipeline


def diarize_turns(audio_path: str, hf_token: str):
    """오디오에서 화자가 바뀌는 시점만 추출. 라벨은 무시.
    반환값: 단일 화자 구간들 [(start, end), ...] (시간 순서)"""
    pipeline = get_diar_pipeline(hf_token)
    diar = pipeline(audio_path)
    # itertracks: (Segment, track_name, speaker_label) — speaker_label은 의도적으로 버림
    segments = []
    for turn, _, _ in diar.itertracks(yield_label=True):
        segments.append((turn.start, turn.end))
    # 시간 순서로 정렬 (보통 이미 정렬되어 있지만 안전망)
    segments.sort(key=lambda s: s[0])
    return segments


def speaker_index_at(turns, t: float) -> int:
    """타임스탬프 t가 몇 번째 turn에 속하는지 반환. 어디에도 안 속하면 -1."""
    for i, (s, e) in enumerate(turns):
        if s <= t <= e:
            return i
    return -1


def merge_with_turns(segments, turns):
    """Whisper segment 리스트와 turn 경계를 가지고 단락 분리된 텍스트 생성.
    같은 turn에 속한 segment들은 공백으로 합치고, turn이 바뀌면 \n\n 삽입."""
    if not segments:
        return ""
    if not turns:
        return " ".join(seg["text"] for seg in segments).strip()

    parts = []
    prev_turn = None
    for seg in segments:
        # segment의 중간 시간으로 turn 매핑 (시작/끝이 경계 걸치면 중간이 가장 안정)
        mid = (seg["start"] + seg["end"]) / 2.0
        cur_turn = speaker_index_at(turns, mid)
        if prev_turn is None:
            parts.append(seg["text"])
        elif cur_turn != prev_turn and cur_turn != -1:
            parts.append("\n\n" + seg["text"])
        else:
            parts.append(" " + seg["text"])
        if cur_turn != -1:
            prev_turn = cur_turn
    return "".join(parts).strip()


def build_output(result: dict, turns=None) -> dict:
    cleaned_segments = [
        {
            "start": seg["start"],
            "end": seg["end"],
            "text": squash_repetitions(seg["text"]).strip(),
        }
        for seg in result.get("segments", [])
    ]
    if turns:
        text = merge_with_turns(cleaned_segments, turns)
    else:
        text = squash_repetitions(result["text"]).strip()
    return {
        "text": text,
        "segments": cleaned_segments,
        "language": result.get("language", "ko"),
    }


def transcribe(audio_path: str, model: str, initial_prompt: str = "") -> None:
    try:
        import mlx_whisper
    except ImportError:
        error = {
            "error": "mlx_whisper이 설치되지 않았습니다. 아래 명령으로 설치하세요:\npip install mlx-whisper"
        }
        print(json.dumps(error), flush=True)
        sys.exit(1)

    if not os.path.exists(audio_path):
        error = {"error": f"오디오 파일을 찾을 수 없습니다: {audio_path}"}
        print(json.dumps(error), flush=True)
        sys.exit(1)

    kwargs = dict(
        path_or_hf_repo=model,
        language="ko",
        word_timestamps=False,
        verbose=False,
    )
    if initial_prompt:
        kwargs["initial_prompt"] = initial_prompt

    with silenced_stderr():
        result = mlx_whisper.transcribe(audio_path, **kwargs)

    print(json.dumps(build_output(result), ensure_ascii=False), flush=True)


def run_server(model: str, default_hf_token: str = "") -> None:
    """stdin에서 JSON 요청을 읽고 전사 결과를 stdout에 출력하는 서버 모드.
    요청에 diarize=true가 있으면 pyannote로 turn boundary 추출 후 단락 분리."""
    try:
        import mlx_whisper
    except ImportError:
        sys.exit(1)

    # 서버 모드는 전 구간 stderr 억제 (mlx_whisper progress bar deadlock 방지).
    # 단발 호출과 달리 매 요청마다 wrap하지 않음 — 프로세스 종료 시 OS가 회수.
    devnull = open(os.devnull, "w")
    sys.stderr = devnull

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            audio_path = req.get("audio_path", "")
            initial_prompt = req.get("initial_prompt", "")
            diarize = bool(req.get("diarize", False))
            hf_token = req.get("hf_token", default_hf_token)

            if not os.path.exists(audio_path):
                print(json.dumps({"error": f"오디오 파일을 찾을 수 없습니다: {audio_path}"}), flush=True)
                continue

            kwargs = dict(
                path_or_hf_repo=model,
                language="ko",
                word_timestamps=False,
                verbose=False,
            )
            if initial_prompt:
                kwargs["initial_prompt"] = initial_prompt

            result = mlx_whisper.transcribe(audio_path, **kwargs)

            turns = None
            if diarize and hf_token:
                # 토큰 있으면 시도. 실패해도 일반 전사 결과를 살리기 위해 에러 대신 fallback.
                try:
                    turns = diarize_turns(audio_path, hf_token)
                except Exception as e:
                    msg = _mask_token(str(e), hf_token)
                    print(f"[diarize] 실패, 일반 모드로 fallback: {msg}", file=_original_stderr)
                    turns = None
            # diarize 요청됐지만 토큰 없으면 조용히 일반 모드로 진행 (JS 측에서 이미 차단해야 함)

            print(json.dumps(build_output(result, turns), ensure_ascii=False), flush=True)

        except json.JSONDecodeError:
            continue
        except Exception as e:
            print(json.dumps({"error": str(e)}), flush=True)


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "--server":
        model_name = sys.argv[2] if len(sys.argv) > 2 else "mlx-community/whisper-large-v3"
        # 옵션: --diarize-token <token> — 매 요청에 토큰 주는 대신 서버 시작 시 한 번
        default_token = ""
        if "--diarize-token" in sys.argv:
            i = sys.argv.index("--diarize-token")
            if i + 1 < len(sys.argv):
                default_token = sys.argv[i + 1]
        run_server(model_name, default_token)
    else:
        if len(sys.argv) < 2:
            print(
                json.dumps({"error": "사용법: transcribe.py <audio_path> [model]"}),
                flush=True,
            )
            sys.exit(1)
        audio = sys.argv[1]
        model_name = sys.argv[2] if len(sys.argv) > 2 else "mlx-community/whisper-large-v3"
        prompt = sys.argv[3] if len(sys.argv) > 3 else ""
        transcribe(audio, model_name, prompt)
