#!/usr/bin/env bash
set -euo pipefail

readonly version="v0.3.1"
readonly name="saanotts-jp-v3-int8.bin"
readonly expected="2d2b8543c06b6a749f19c9918de68244409e2bb6ad1d921a90b5c358f96d4d79"
readonly url="https://github.com/ayutaz/sanoTTS-jp/releases/download/${version}/${name}"
readonly root="$(cd "$(dirname "$0")/.." && pwd)"
readonly destination="${root}/lib/sanotts/model/${name}"
readonly temporary="${destination}.download"

mkdir -p "$(dirname "${destination}")"
trap 'rm -f "${temporary}"' EXIT

echo "Downloading sanoTTS-jp blob v2 from upstream ${version}..."
if ! curl --fail --location --retry 3 --output "${temporary}" "${url}"; then
  cat >&2 <<'HELP'
The pinned release is unavailable. The firmware still builds without weights.
To generate blob v2, check out ayutaz/sanoTTS-jp at
a478680073aacfec4fc16c31e370d63ef09c8d14, install its Python requirements,
obtain saanotts-jp-v3-stage4.pt from the upstream v0.2.0 release, then run:
  uv sync
  uv run python scripts/export_c_weights.py --ckpt saanotts-jp-v3-stage4.pt \
    --out csrc/saanotts-jp-v3-int8.bin --int8
See the upstream README for checkpoint acquisition and environment setup.
The result must match the SHA-256 pinned in this script; do not use the v0.2.0 v1 blob.
Install the verified result as lib/sanotts/model/saanotts-jp-v3-int8.bin.
HELP
  exit 1
fi

if command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "${temporary}" | awk '{print $1}')"
elif command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "${temporary}" | awk '{print $1}')"
else
  echo "No SHA-256 utility found (need shasum or sha256sum)." >&2
  exit 1
fi

if [[ "${actual}" != "${expected}" ]]; then
  echo "SHA-256 mismatch: expected ${expected}, got ${actual}" >&2
  echo "Remove the download and regenerate blob v2 with upstream scripts/export_c_weights.py --int8 if the pinned release is unavailable." >&2
  exit 1
fi

mv "${temporary}" "${destination}"
echo "Installed ${destination} (${expected})"
echo "The model has non-MIT terms; read lib/sanotts/NOTICE.md before use or redistribution."
