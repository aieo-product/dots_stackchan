#include <M5Unified.h>
#include "tts-protocol.h"

namespace {
class M5PcmSink : public dots::PcmSink {
 public:
  size_t queued() const override { return M5.Speaker.isPlaying(0); }
  bool play(const int16_t* samples, size_t count) override {
    return M5.Speaker.playRaw(samples, count, 16000, false, 1, 0);
  }
  void stop() override {
    // end() joins the playback task so interrupted buffers can safely be reused.
    M5.Speaker.end(); M5.Speaker.begin();
  }
} sink;

void done(uint16_t seq, bool ok) {
  Serial.printf("{\"type\":\"tts.done\",\"seq\":%u,\"ok\":%s}\n", seq, ok ? "true" : "false");
}
void mode(const char* value, const char* engine) {
  M5.Display.fillRect(0, 0, M5.Display.width(), 30, TFT_BLACK);
  M5.Display.setTextDatum(top_center);
  // Only display known engine names, never provider input or URLs.
  const char* label = !strcmp(value, "device") ? "device / sanoTTS" :
    !strcmp(engine, "voicevox") ? "bridge / VOICEVOX" :
    !strcmp(engine, "local-http") ? "bridge / local-http" :
    !strcmp(engine, "openai") ? "bridge / OpenAI" : "bridge / PCM";
  M5.Display.drawString(label, M5.Display.width() / 2, 8);
}
dots::PcmPlayer player(sink, done);
dots::TtsProtocol protocol(player, done, mode);

// USB developer harness: [length u16 LE][kind u8 + JSON | v1 binary frame].
// WSS authentication/transport belongs to #4/#5, with the same handlers.
void receiveUsb() {
  static uint8_t frame[4096];
  static size_t received = 0, length = 0;
  static uint8_t header[2];
  static size_t headers = 0;
  static uint32_t last = 0;
  if ((headers || received) && millis() - last > 1000) { headers = received = length = 0; }
  for (size_t budget = 0; budget < 8192 && Serial.available(); ++budget) {
    const uint8_t value = Serial.read(); last = millis();
    if (headers < 2) {
      header[headers++] = value;
      if (headers == 2) {
        length = header[0] | (static_cast<size_t>(header[1]) << 8);
        if (!length || length > sizeof(frame)) { headers = 0; length = 0; }
      }
    } else {
      frame[received++] = value;
      if (received == length) {
        if (frame[0] == 0x01) protocol.text(frame + 1, length - 1, millis());
        else protocol.binary(frame, length, millis());
        headers = received = length = 0;
        player.tick(millis());
      }
    }
  }
}
}  // namespace

void setup() {
  auto config = M5.config();
  M5.begin(config);
  Serial.begin(921600);
  M5.Speaker.end();
  auto speaker = M5.Speaker.config();
  speaker.dma_buf_len = 256; speaker.dma_buf_count = 4; speaker.sample_rate = 48000;
  M5.Speaker.config(speaker); M5.Speaker.begin(); M5.Speaker.setVolume(128);
  M5.Display.setTextDatum(middle_center);
  M5.Display.drawString("dots_stackchan", M5.Display.width() / 2, M5.Display.height() / 2);
  mode("bridge", "openai");
  Serial.println("{\"type\":\"caps\",\"sanotts\":false,\"pcm_stream\":true}");
}

void loop() {
  M5.update();
  receiveUsb(); player.tick(millis());
  static uint32_t rendered = 0;
  if (millis() - rendered >= 20) {
    rendered = millis();
    const int opening = std::min(40, static_cast<int>(player.level() * 100));
    const int x = M5.Display.width() / 2;
    const int y = M5.Display.height() * 3 / 4;
    M5.Display.fillRect(x - 40, y - 22, 80, 44, TFT_BLACK);
    M5.Display.fillEllipse(x, y, 25, 2 + opening / 2, TFT_WHITE);
  }
  delay(1);
}
