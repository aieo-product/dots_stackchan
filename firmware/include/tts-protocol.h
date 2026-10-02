#pragma once
#include <ArduinoJson.h>
#include <cstring>
#include "pcm-player.h"

namespace dots {
// The WSS integration can call text()/binary() from the same thread as tick().
// The standalone firmware also exposes these via length-prefixed USB frames.
class TtsProtocol {
 public:
  using Mode = void (*)(const char* mode, const char* engine);
  using Kana = void (*)(uint16_t seq, const char* kana);
  TtsProtocol(PcmPlayer& player, PcmPlayer::Done done, Mode mode, Kana kana = nullptr)
      : player_(player), done_(done), mode_(mode), kana_(kana) {}
  void text(const uint8_t* bytes, size_t length, uint32_t now) {
    JsonDocument json;
    if (deserializeJson(json, bytes, length)) return;
    const char* type = json["type"] | "";
    if (!std::strcmp(type, "tts.cancel")) { player_.cancel(); return; }
    if (!std::strcmp(type, "voice.mode")) {
      const char* mode = json["mode"] | "";
      if (!std::strcmp(mode, "device") || !std::strcmp(mode, "bridge")) mode_(mode, json["engine"] | "");
      return;
    }
    const int seq = json["seq"] | 0;
    if (seq < 1 || seq > 65535) return;
    if (!std::strcmp(type, "tts.start")) {
      if ((json["sample_rate"] | 0) != 16000 || (json["channels"] | 0) != 1 || (json["bits"] | 0) != 16) {
        player_.cancel(); done_(seq, false); return;
      }
      mode_("bridge", json["engine"] | "pcm"); player_.start(seq, now);
    } else if (!std::strcmp(type, "tts.end")) player_.end(seq);
    else if (!std::strcmp(type, "speak.kana")) {
      player_.cancel(); mode_("device", "sanoTTS");
      if (kana_ && json["kana"].is<const char*>()) kana_(seq, json["kana"]);
      else done_(seq, false);  // Advertise caps.sanotts=false until #5 supplies it.
    }
  }
  void binary(const uint8_t* frame, size_t length, uint32_t now) {
    if (length < 3 || frame[0] != 0x02) return;
    const uint16_t seq = frame[1] | (static_cast<uint16_t>(frame[2]) << 8);
    player_.push(seq, frame + 3, length > 4096 ? 0 : length - 3, now);
  }
 private:
  PcmPlayer& player_;
  PcmPlayer::Done done_;
  Mode mode_;
  Kana kana_;
};
}  // namespace dots
