Import("env")

from pathlib import Path
import hashlib
import os
import struct

model = Path(env.subst("$PROJECT_DIR")) / "lib" / "sanotts" / "model" / "saanotts-jp-v3-int8.bin"
if model.is_file() and os.environ.get("DOTS_SANOTTS") != "0":
    blob = model.read_bytes()
    expected = "2d2b8543c06b6a749f19c9918de68244409e2bb6ad1d921a90b5c358f96d4d79"
    if hashlib.sha256(blob).hexdigest() != expected or struct.unpack_from("<I", blob, 4)[0] != 2:
        raise RuntimeError("sanoTTS weights: wrong SHA-256 or blob version (need pinned v2)")
    env.Append(CPPDEFINES=[("DOTS_SANOTTS", 1)])
    env.Append(BUILD_FLAGS=[f'-DSAAN_BLOB_PATH=\\"{model}\\"'])
    print(f"sanoTTS: enabled ({model.stat().st_size} bytes)")
else:
    env.Append(CPPDEFINES=[("DOTS_SANOTTS", 0)])
    print("sanoTTS: disabled (run scripts/fetch-sanotts-model.sh to install weights)")
