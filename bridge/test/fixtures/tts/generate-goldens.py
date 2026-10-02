"""Run with uv + piper-plus-g2p==0.2.0 + pyopenjtalk-plus==0.4.1.post9.

Pass the sanoTTS-jp checkout as the first argument. No training dependencies
are needed. The upstream author's actual script produces these fixtures.
"""
import hashlib
import importlib.metadata
import json
import pathlib
import subprocess
import sys

root = pathlib.Path(sys.argv[1])
sys.path.insert(0, str(root / "scripts"))
import kana_g2p  # noqa: E402
import pyopenjtalk  # noqa: E402

here = pathlib.Path(__file__).parent
table = kana_g2p.load_frozen_mora_table()
sentences = json.loads((here / "sentences.json").read_text())
rows = []
for row in sentences:
    kana = "".join(kana_g2p.text_to_intermediate(row["normalized"], table))
    rows.append({**row, "labels": pyopenjtalk.extract_fullcontext(row["normalized"]), "kana": kana.removeprefix("^").removesuffix("$")})
(here / "golden.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2) + "\n")

provenance = {
    "upstreamCommit": subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip(),
    "scriptSha256": hashlib.sha256((root / "scripts" / "kana_g2p.py").read_bytes()).hexdigest(),
    "moraTableSha256": json.loads((root / "csrc" / "g2p_table.json").read_text())["sha256"],
    "piperPlusG2p": importlib.metadata.version("piper-plus-g2p"),
    "pyopenjtalkPlus": importlib.metadata.version("pyopenjtalk-plus"),
    "sentences": len(rows),
}
(here / "provenance.json").write_text(json.dumps(provenance, indent=2) + "\n")
