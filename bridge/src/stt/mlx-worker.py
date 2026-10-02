"""Persistent MLX worker. Only bounded PCM and JSON results pass through pipes."""
import argparse
import base64
import contextlib
import json
import os
import sys


def reply(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    args = parser.parse_args()
    # Libraries may print download paths, progress, or decoded text. Suppress them.
    with open(os.devnull, "w") as quiet:
        try:
            with contextlib.redirect_stdout(quiet), contextlib.redirect_stderr(quiet):
                import mlx.core as mx
                import numpy as np
                from mlx_whisper.transcribe import ModelHolder, transcribe

                model = ModelHolder.get_model(args.model, mx.float16)
                mx.eval(model.parameters())
            reply({"ready": True})
        except Exception:
            reply({"error": True})
            return
        while True:
            # 480,000 PCM bytes become at most 640,000 base64 bytes.
            line = sys.stdin.buffer.readline(650_001)
            if not line:
                return
            if len(line) > 650_000 or not line.endswith(b"\n"):
                return
            request_id = None
            try:
                request = json.loads(line)
                request_id = request["id"]
                pcm = base64.b64decode(request["pcm"], validate=True)
                if not 0 < len(pcm) <= 480_000 or len(pcm) % 2:
                    raise ValueError("Invalid PCM")
                audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
                with contextlib.redirect_stdout(quiet), contextlib.redirect_stderr(quiet):
                    result = transcribe(
                        audio, path_or_hf_repo=args.model, language=request["language"],
                        initial_prompt="スタックちゃん", verbose=None,
                        temperature=0.0, condition_on_previous_text=False,
                    )
                reply({"id": request_id, "text": result["text"].strip()})
            except Exception:
                reply({"id": request_id, "error": True})


if __name__ == "__main__":
    main()
