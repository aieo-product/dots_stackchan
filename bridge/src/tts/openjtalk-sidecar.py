"""Persistent JSON-lines G2P worker; stdout carries only protocol responses."""
import contextlib
import json
import sys

with contextlib.redirect_stdout(sys.stderr):
    from piper_plus_g2p.japanese import JapanesePhonemizer

phonemizer = JapanesePhonemizer()
# Warm dictionary and analyzer before announcing readiness.
phonemizer.phonemize("準備できました。")
print(json.dumps({"ready": True}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    try:
        phones = phonemizer.phonemize(request["text"])
        response = {"id": request["id"], "phones": phones}
    except Exception:
        response = {"id": request["id"], "error": True}
    print(json.dumps(response, ensure_ascii=False), flush=True)
