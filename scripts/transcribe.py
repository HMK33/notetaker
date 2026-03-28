#!/usr/bin/env python3
"""
mlx-whisper 전사 스크립트
사용법 (단일):  python3 transcribe.py <audio_path> [model_name] [initial_prompt]
사용법 (서버):  python3 transcribe.py --server [model_name]
  stdin  → {"audio_path": "...", "initial_prompt": "..."}\n
  stdout ← {"text": "...", "segments": [...], "language": "..."}\n  또는  {"error": "..."}\n
"""
import sys
import json
import os
import re

_original_stderr = sys.stderr


def squash_repetitions(text: str) -> str:
    pattern = r"(.+?)(?:[\s,]+\1){4,}"
    return re.sub(pattern, r"\1", text)


def build_output(result: dict) -> dict:
    return {
        "text": squash_repetitions(result["text"]).strip(),
        "segments": [
            {
                "start": seg["start"],
                "end": seg["end"],
                "text": squash_repetitions(seg["text"]).strip(),
            }
            for seg in result.get("segments", [])
        ],
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

    sys.stderr = open(os.devnull, "w")
    try:
        result = mlx_whisper.transcribe(audio_path, **kwargs)
    finally:
        sys.stderr = _original_stderr

    print(json.dumps(build_output(result), ensure_ascii=False), flush=True)


def run_server(model: str) -> None:
    """stdin에서 JSON 요청을 읽고 전사 결과를 stdout에 출력하는 서버 모드.
    모델을 한 번만 로딩하여 청크당 재로딩 없이 빠르게 처리."""
    try:
        import mlx_whisper
    except ImportError:
        sys.exit(1)

    # stderr 억제 (mlx_whisper progress bar deadlock 방지)
    sys.stderr = open(os.devnull, "w")

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            audio_path = req.get("audio_path", "")
            initial_prompt = req.get("initial_prompt", "")

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
            print(json.dumps(build_output(result), ensure_ascii=False), flush=True)

        except json.JSONDecodeError:
            continue
        except Exception as e:
            print(json.dumps({"error": str(e)}), flush=True)


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "--server":
        model_name = sys.argv[2] if len(sys.argv) > 2 else "mlx-community/whisper-large-v3"
        run_server(model_name)
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
