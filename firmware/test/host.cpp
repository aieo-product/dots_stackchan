#include <cassert>
#include <iostream>
#include <time.h>
#include <M5Unified.h>
#include <esp_heap_caps.h>
#include "audio/player.h"
#include "net/ws_link.h"
#if DOTS_SANOTTS
#include "audio/sanotts_voice.h"
extern std::function<void()> testPullHook;
#endif

static time_t clockSeconds = 0;
#ifdef __linux__
#define DOTS_TIME_NOEXCEPT noexcept
#else
#define DOTS_TIME_NOEXCEPT
#endif
extern "C" time_t time(time_t* value) DOTS_TIME_NOEXCEPT {
  if (value) *value = clockSeconds;
  return clockSeconds;
}
namespace dots {
void FaceController::setMouth(float) {}
void FaceController::setState(const char*) {}
}
using namespace dots;
static protocol::Command decode(const char* text) {
  protocol::Command command;
  assert(protocol::decodeText(reinterpret_cast<const uint8_t*>(text), strlen(text), command));
  return command;
}
int main() {
  for (const char* text : {"{\"type\":\"face\",\"expression\":\"happy\"}",
       "{\"type\":\"look\",\"pan\":120,\"tilt\":-50}",
       "{\"type\":\"speak.kana\",\"seq\":65535,\"kana\":\"コンニチワ。\"}",
       "{\"type\":\"tts.cancel\"}", "{\"type\":\"chime\",\"kind\":\"notify\"}"}) decode(text);
  for (const char* text : {"[]", "{\"type\":\"face\",\"expression\":\"bad\"}",
       "{\"type\":\"look\",\"pan\":\"bad\"}", "{\"type\":\"speak.kana\",\"seq\":-1,\"kana\":\"ア\"}",
       "{\"type\":\"tts.start\",\"seq\":1,\"sample_rate\":16000,\"channels\":2,\"bits\":16}"}) {
    protocol::Command command;
    assert(!protocol::decodeText(reinterpret_cast<const uint8_t*>(text), strlen(text), command));
  }
  // Simulated bridge + transport: actual WsLink builds the auth headers and dispatches v1 frames.
  DeviceConfig config;
  config.server = "wss://example.org/device";
  config.deviceId = "test-device";
  config.psk = "00000000000000000000000000000000";
  WsLink link;
  unsigned faces = 0, connections = 0;
  link.begin(config, [&](const uint8_t* text, size_t length) {
    protocol::Command command;
    assert(protocol::decodeText(text, length, command));
    assert(command.type == protocol::CommandType::Face);
    ++faces;
  }, nullptr, [&](bool online) {
    if (online) { ++connections; link.send(protocol::hello("test", false, true)); }
  });
  auto& socket = *WebSocketsClient::instance;
  testMillis = 5000;
  link.update(true);
  assert(socket.starts == 0);  // don't sign an unset clock
  clockSeconds = 1800000000;
  testMillis = 10000;
  link.update(true);
  assert(socket.starts == 1 && socket.verified);
  assert(socket.headers.find("X-Device-Id: test-device\r\nX-Timestamp: 1800000000\r\nX-Auth: ") == 0);
  assert(socket.headers.find("X-Auth: 8da29b9884da7bc8e8d67e0e9d6e5c9b3d824f8562a11c39299b350bfb7104a9") != std::string::npos);
  socket.handler(WStype_CONNECTED, nullptr, 0);
  assert(link.connected() && socket.sent.back().find("\"sanotts\":false") != std::string::npos);
  std::string face = "{\"type\":\"face\",\"expression\":\"happy\"}";
  socket.handler(WStype_TEXT, reinterpret_cast<uint8_t*>(face.data()), face.size());
  socket.disconnect();
  clockSeconds += 120;
  link.update(true);
  assert(socket.headers.find("X-Timestamp: 1800000120") != std::string::npos);
  socket.handler(WStype_CONNECTED, nullptr, 0);
  assert(connections == 2 && faces == 1);
  link.update(false);
  assert(!link.connected());

  FaceController avatar;
  AudioPlayer player;
  std::vector<std::pair<uint16_t, bool>> done;
  player.begin(avatar, [&](uint16_t seq, bool ok) { done.emplace_back(seq, ok); });
  auto start = decode("{\"type\":\"tts.start\",\"seq\":42,\"sample_rate\":16000,\"channels\":1,\"bits\":16}");
  assert(player.startPcm(start));
  const uint8_t bytes[] = {2, 42, 0, 0, 1, 0, 2};
  protocol::BinaryFrame frame;
  assert(protocol::decodeBinary(bytes, sizeof(bytes), frame));
  ++frame.seq;
  assert(!player.appendPcm(frame));
  --frame.seq;
  assert(player.appendPcm(frame));
  assert(!player.endPcm(41));
  assert(player.endPcm(42));
  player.update();
  assert(M5.Speaker.queuedSamples == 2);
  M5.Speaker.slots = 0;
  player.update();
  assert((done.back() == std::pair<uint16_t, bool>(42, true)));
  assert(player.startPcm(start) && player.appendPcm(frame) && player.endPcm(42));
  player.update();
  const auto freed = testFrees;
  player.cancel();
  assert(testFrees == freed && M5.Speaker.stopped);
  player.update();
  assert(testFrees == freed);  // stop is asynchronous
  M5.Speaker.slots = 0;
  player.update();
  assert(testFrees == freed + 1);
  assert((done.back() == std::pair<uint16_t, bool>(42, false)));
  size_t produced = 2;
  bool released = false;
  int16_t pcm[10] = {};
  assert(player.playGenerated(pcm, 10, 22050, 43, [&] { released = true; }, [&] { return produced; }));
  const auto queued = M5.Speaker.queuedSamples;
  player.update();
  player.update();
  assert(M5.Speaker.queuedSamples == queued + 2);  // never enqueue unproduced samples
  produced = 10;
  player.update();
  M5.Speaker.slots = 0;
  player.update();
  assert(released && done.back().first == 43 && done.back().second);
#if DOTS_SANOTTS
  SanoTtsVoice voice;
  done.clear();
  voice.begin(player, [&](uint16_t seq) { done.emplace_back(seq, false); });
  assert(voice.available() && voice.start(44, "こんにちわ"));
  testPullHook = [&] { voice.update(); player.update(); };
  testTask();  // produce one chunk, begin playback, then fail inference
  const auto voiceFrees = testFrees;
  voice.update();
  assert(done.size() == 1 && done.back().first == 44 && !done.back().second);
  assert(testFrees == voiceFrees);  // never free while the speaker still owns PCM
  player.update();
  assert(testFrees == voiceFrees);
  M5.Speaker.slots = 0;
  player.update();
  voice.update();
  assert(testFrees == voiceFrees + 1);
  assert(voice.start(45, "こんにちわ"));
  voice.cancel();  // cancel before the synthesis task gets scheduled
  testPullHook = nullptr;
  voice.update();
  assert(!voice.start(46, "こんにちわ"));
  testTask();
  voice.update();
  assert(done.size() == 2 && done.back().first == 45 && !done.back().second);
#endif
  std::cout << "host: protocol validation, mock bridge auth/reconnect, PCM lifecycle and progressive playback passed\n";
}
