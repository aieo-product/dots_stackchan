#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT
if [[ ! -d firmware/.pio/libdeps/m5stack-cores3/ArduinoJson/src ]]; then
  echo "Run pio run -d firmware first to install ArduinoJson." >&2
  exit 1
fi
# OpenSSL supplies host HMAC; the firmware uses mbedTLS. Transport and speaker are mocks.
read -r -a crypto_flags <<< "$(pkg-config --cflags --libs openssl)"
c++ -std=c++17 -fsanitize=address,undefined -g \
  -DARDUINOJSON_ENABLE_ARDUINO_STRING=1 -DARDUINOJSON_ENABLE_ARDUINO_STREAM=0 \
  -Ifirmware/test/stubs -Ifirmware/src \
  -Ifirmware/.pio/libdeps/m5stack-cores3/ArduinoJson/src \
  firmware/test/host.cpp firmware/src/protocol.cpp firmware/src/audio/player.cpp \
  firmware/src/audio/sanotts_voice.cpp firmware/src/audio/speech_dispatcher.cpp \
  firmware/src/audio/mic.cpp firmware/src/input.cpp \
  firmware/src/net/ws_link.cpp "${crypto_flags[@]}" -o "$temporary/host"
"$temporary/host"
cc -std=c99 -c firmware/lib/sanotts/src/g2p.c -o "$temporary/g2p.o"
c++ -std=c++17 -fsanitize=address,undefined -g -DDOTS_SANOTTS=1 \
  -DARDUINOJSON_ENABLE_ARDUINO_STRING=1 -DARDUINOJSON_ENABLE_ARDUINO_STREAM=0 \
  -Ifirmware/test/stubs -Ifirmware/src -Ifirmware/lib/sanotts/src \
  -Ifirmware/.pio/libdeps/m5stack-cores3/ArduinoJson/src \
  firmware/test/host.cpp firmware/test/voice_mock.cpp firmware/src/protocol.cpp \
  firmware/src/audio/player.cpp firmware/src/audio/sanotts_voice.cpp \
  firmware/src/audio/speech_dispatcher.cpp \
  firmware/src/audio/mic.cpp firmware/src/input.cpp \
  firmware/src/net/ws_link.cpp "$temporary/g2p.o" "${crypto_flags[@]}" -o "$temporary/voice"
"$temporary/voice"
c++ -std=c++17 -fsanitize=address,undefined -g -DDOTS_MIC_VAD=1 \
  -DARDUINOJSON_ENABLE_ARDUINO_STRING=1 -DARDUINOJSON_ENABLE_ARDUINO_STREAM=0 \
  -Ifirmware/test/stubs -Ifirmware/src \
  -Ifirmware/.pio/libdeps/m5stack-cores3/ArduinoJson/src \
  firmware/test/host.cpp firmware/src/protocol.cpp firmware/src/audio/player.cpp \
  firmware/src/audio/sanotts_voice.cpp firmware/src/audio/speech_dispatcher.cpp \
  firmware/src/audio/mic.cpp firmware/src/input.cpp firmware/src/net/ws_link.cpp \
  "${crypto_flags[@]}" -o "$temporary/vad"
"$temporary/vad"
