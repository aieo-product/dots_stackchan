# Provenance

`src/` is a verbatim copy of the C99 inference core from
[ayutaz/sanoTTS-jp](https://github.com/ayutaz/sanoTTS-jp) `csrc/`
at commit `a478680073aacfec4fc16c31e370d63ef09c8d14` (2026-09-03, post-v0.2.0
with the S1–S5a speed work and blob format v2):

| file | role |
|---|---|
| `saanotts.c` / `saanotts_stream.c` / `fft.c` / `saanotts_int8.c` | inference core (all four are required to link) |
| `g2p.c` + `g2p_table.h` | kana intermediate representation → student ids (on-device G2P) |
| `*.h` | headers of the above |

Port files written for this project: `saan_port_dots.h`, `saan_model_blob.S`,
`saan_model_blob.h`, and `library.json`.

Build configuration = upstream `esp32/boards/m5unified` with
`SAAN_INT8_ACT=1 SAAN_PIE=1` (W8A8 + ESP32-S3 PIE SIMD), `-O2`, and the erf
table in DRAM.

`model/saanotts-jp-v3-int8.bin` is the blob-v2 release asset from upstream
v0.3.1. It is not committed and is not MIT licensed. See `NOTICE.md`.

To update: copy the inference-core files from a newer upstream commit, verify
the model format and checksum, and record the commit here. Do not edit the core
in place.
