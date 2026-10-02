#include <cassert>
#include <iostream>
#include <time.h>
#include <M5Unified.h>
#include <esp_heap_caps.h>
#include "audio/player.h"
#include "audio/fillers.h"
#include "audio/speech_dispatcher.h"
#include "audio/mic.h"
#include "input.h"
#include "net/ws_link.h"
#if DOTS_SANOTTS
#include "audio/sanotts_voice.h"
extern std::function<void()> testPullHook;
extern bool testVoiceSuccess;
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
static float mouth = 0;
static std::string voiceMode;
static std::string faceState;
static bool showingCredits = false;
namespace dots {
void FaceController::setMouth(float value) { mouth = value; }
void FaceController::setState(const char* value) { faceState = value; }
void FaceController::setVoiceMode(const char* value) { voiceMode = value; }
bool FaceController::setExpression(const String&) { return true; }
void FaceController::showCredits(bool value) { showingCredits = value; }
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
       "{\"type\":\"voice.mode\",\"mode\":\"bridge\"}",
       "{\"type\":\"tts.cancel\"}", "{\"type\":\"chime\",\"kind\":\"notify\"}"}) decode(text);
  for (const char* text : {"{\"type\":\"voice.mode\",\"mode\":\"bad\"}", "[]", "{\"type\":\"face\",\"expression\":\"bad\"}",
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
  socket.handler(WStype_CONNECTED, nullptr, 0);
  assert(protocol::hello("test", false, true, true).find("\"mic\":true") != std::string::npos);
  assert(protocol::micStart(65535) == "{\"type\":\"mic.start\",\"seq\":65535,\"sample_rate\":16000}");
  assert(protocol::micEnd(65535, "release") == "{\"type\":\"mic.end\",\"seq\":65535,\"reason\":\"release\"}");
  uint8_t micBytes[] = {1, 255, 255, 0, 128};
  assert(link.sendBinary(micBytes, sizeof(micBytes)) && socket.binary.size() == 1);
  std::atomic<bool> aborted{true};
  assert(!link.sendBinary(micBytes, sizeof(micBytes), &aborted));
  assert(!link.send(protocol::micEnd(65535, "release"), &aborted));
  assert(!link.sendBinary(micBytes, 4097) && !link.sendBinary(nullptr, 5));
  link.update(false);
  assert(!link.sendBinary(micBytes, sizeof(micBytes)));

  FaceController avatar;
  DeviceInput input;
  std::vector<bool> holds;
  unsigned inputEvents = 0;
  input.begin(avatar, [&](const char*, const String&) { ++inputEvents; },
      [&](bool held) { holds.push_back(held); });
  M5.Touch.details = {{true}}; input.update(); input.update();
  assert(holds == std::vector<bool>{true} && inputEvents == 0);
  M5.Touch.details = {{true}, {true}}; input.update();
  M5.Touch.details = {{false}, {true}}; input.update();
  M5.BtnA.pressed = true; M5.Touch.details.clear(); input.update();
  assert(holds.size() == 1); // wait until all sources are released
  M5.BtnA.pressed = false; input.update(); input.update();
  assert((holds == std::vector<bool>{true, false}));
  input.showCredits(true); assert(showingCredits);
  M5.BtnA.pressed = true; input.update(); input.update();
  assert(!showingCredits && holds.size() == 3 && holds.back());
  M5.BtnA.pressed = false; input.update();
  assert(holds.size() == 4 && !holds.back());
  M5.BtnB.hold = true; input.update(); assert(showingCredits);
  M5.BtnB.hold = false; input.showCredits(false);
  Microphone mic;
  mic.begin(link, avatar);
  assert(mic.available() && !mic.start()); // offline never records
  socket.handler(WStype_CONNECTED, nullptr, 0);
  auto startMic = [&] {
    testMicTasks.clear();
    assert(mic.start() && mic.busy());
    assert(!M5.Speaker.running && M5.Mic.running && faceState == "listening");
    assert(testMicTasks.size() == 2 && !mic.start());
  };
  unsigned localEnds = 0;
  mic.onEnd([&](uint16_t) { assert(!M5.Mic.running && M5.Speaker.running); ++localEnds; });
  startMic();
  unsigned capturedFrames = 0;
  testDelayHook = [&] {
    assert(!M5.Speaker.running);
    if (++capturedFrames <= 3) M5.Mic.complete();
    else mic.release();
  };
  const auto binaryBeforeMic = socket.binary.size();
  testMicTasks[1](); // capture owner, while TX is deliberately held back
  assert(!M5.Mic.running && !M5.Speaker.running);
  mic.update(); assert(mic.busy() && !mic.capturing() && M5.Speaker.running && localEnds == 1); // playback may start before TX finishes
  testMicTasks[0](); // independent TX task drains all frames, then sends exactly one end
  mic.update();
  assert(!mic.busy() && M5.Speaker.running && faceState == "thinking");
  assert(socket.binary.size() == binaryBeforeMic + 3);
  for (size_t i = binaryBeforeMic; i < socket.binary.size(); ++i) {
    const auto& pcm = socket.binary[i];
    assert(pcm.size() == 643 && pcm[0] == 1 && pcm[1] == 1 && pcm[2] == 0);
    assert(pcm[3] == 0xd2 && pcm[4] == 4);
  }
  assert(socket.sent.back() == protocol::micEnd(1, "release"));
  const auto endedMessages = socket.sent.size();
  mic.release(); mic.update();
  assert(socket.sent.size() == endedMessages); // no duplicate end

  // Full 15 seconds: model a TX consumer draining the bounded queue every frame.
  startMic();
  testQueueSent = [&](TestQueue* queue) { queue->entries.pop_front(); };
  capturedFrames = 0;
  const uint32_t captureStart = testMillis;
  testDelayHook = [&] {
    testMillis = captureStart + ++capturedFrames * 20;
    M5.Mic.complete();
  };
  testMicTasks[1](); testMicTasks[0](); mic.update();
  assert(capturedFrames == 750 && socket.sent.back() == protocol::micEnd(2, "timeout"));
  assert(!mic.busy() && faceState == "thinking");
  testQueueSent = nullptr;

  // Without TX progress, bound memory at 32 frames and end instead of dropping PCM.
  startMic(); capturedFrames = 0;
  testDelayHook = [&] { ++capturedFrames; M5.Mic.complete(); };
  testMicTasks[1](); testMicTasks[0](); mic.update();
  assert(capturedFrames == 33 && socket.sent.back() == protocol::micEnd(3, "timeout"));

  // Disconnect abort discards queued audio/end, including after reconnect.
  startMic();
  testDelayHook = [&] { M5.Mic.complete(); mic.abort(); };
  testMicTasks[1]();
  const auto abortedText = socket.sent.size(), abortedBinary = socket.binary.size();
  testMicTasks[0](); mic.update();
  assert(socket.sent.size() == abortedText && socket.binary.size() == abortedBinary);
  assert(!mic.busy() && faceState == "idle");

  // An early release before capture is scheduled still has ordered start/end.
  startMic(); mic.release(); testMicTasks[1](); testMicTasks[0](); mic.update();
  assert(socket.sent.back() == protocol::micEnd(5, "release"));
  testDelayHook = nullptr;
  M5.Mic.failBegin = true;
  assert(!mic.start() && !mic.busy() && M5.Speaker.running);
  M5.Mic.failBegin = false;
  testFailTask = "mic-capture";
  testMicTasks.clear(); assert(mic.start());
  testMicTasks[0](); mic.update();
  assert(socket.sent.back() == protocol::micEnd(6, "timeout") && !mic.busy());
  testFailTask = "mic-tx";
  assert(mic.start()); mic.update();
  assert(socket.sent.back() == protocol::micEnd(7, "timeout") && !mic.busy());
  testFailTask.clear();
  assert(M5.Mic.callback == nullptr && !M5.Mic.running && M5.Speaker.running);
  startMic(); M5.Mic.failRecord = true;
  testMicTasks[1](); testMicTasks[0](); mic.update();
  assert(socket.sent.back() == protocol::micEnd(8, "timeout") && !mic.busy());
  M5.Mic.failRecord = false;
  startMic();
  testDelayHook = [&] { testMillis += 15000; }; // no mic callbacks: wall-clock cap still works
  testMicTasks[1](); testMicTasks[0](); mic.update();
  assert(socket.sent.back() == protocol::micEnd(9, "timeout") && !mic.busy());
  testDelayHook = nullptr;
#if DOTS_MIC_VAD
  startMic(); capturedFrames = 0;
  testQueueSent = [&](TestQueue* queue) { queue->entries.pop_front(); };
  testDelayHook = [&] { M5.Mic.complete(++capturedFrames == 1 ? 1234 : 0); };
  testMicTasks[1](); testMicTasks[0](); mic.update();
  assert(capturedFrames == 41 && socket.sent.back() == protocol::micEnd(10, "vad"));
  testQueueSent = nullptr; testDelayHook = nullptr;
#endif

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
  // Start after 150 ms, before tts.end. Drain, re-prime and resume on underrun.
  done.clear();
  M5.Speaker.requests.clear();
  assert(player.startPcm(start));
  std::vector<uint8_t> packet(2400, 0);
  for (size_t i = 0; i < packet.size(); i += 2) { packet[i] = 0xe0; packet[i + 1] = 0x2e; } // 12000
  frame.seq = 42; frame.payload = packet.data(); frame.length = packet.size();
  assert(player.appendPcm(frame));
  player.update();
  assert(!player.playing() && M5.Speaker.slots == 0 && player.busy());
  assert(player.appendPcm(frame));
  player.update(); player.update();
  assert(player.playing() && M5.Speaker.slots == 2 && done.empty() && mouth == 1);
  const auto& firstRequest = M5.Speaker.requests.front();
  const auto firstPointer = firstRequest.pointer;
  const auto firstSnapshot = firstRequest.snapshot;
  M5.Speaker.slots = 1; // one request consumed, queued second still owns its pointer
  player.update();
  assert(std::vector<int16_t>(firstPointer, firstPointer + firstSnapshot.size()) == firstSnapshot);
  M5.Speaker.slots = 0;
  player.update();
  assert(mouth == 0 && done.empty()); // no done during an open HTTP stream
  assert(player.appendPcm(frame));
  player.update();
  assert(M5.Speaker.slots == 0); // wait for 150 ms on resume too
  assert(player.appendPcm(frame));
  player.update();
  assert(M5.Speaker.slots == 1 && mouth == 1);
  assert(player.endPcm(42));
  for (unsigned i = 0; i < 10 && player.busy(); ++i) {
    M5.Speaker.slots = 0; player.update();
  }
  assert(!player.busy() && done.size() == 1 && done.back().second);
  assert(mouth == 0);

  // More than two seconds of sequential audio wraps the ring repeatedly.
  M5.Speaker.requests.clear();
  assert(player.startPcm(start));
  size_t sent = 0;
  std::vector<int16_t> expected;
  for (unsigned step = 0; step < 100; ++step) {
    for (size_t i = 0; i < packet.size(); i += 2) {
      const int16_t value = static_cast<int16_t>(static_cast<int>(sent++ % 20000) - 10000);
      expected.push_back(value);
      packet[i] = value & 255; packet[i + 1] = static_cast<uint16_t>(value) >> 8;
    }
    assert(player.appendPcm(frame));
    for (unsigned drain = 0; drain < 2; ++drain) {
      M5.Speaker.slots = M5.Speaker.slots ? M5.Speaker.slots - 1 : 0;
      player.update();
      if (M5.Speaker.slots) {
        const auto& newest = M5.Speaker.requests.back();
        assert(std::vector<int16_t>(newest.pointer, newest.pointer + newest.snapshot.size()) == newest.snapshot);
      }
    }
  }
  assert(player.endPcm(42));
  while (player.busy()) { M5.Speaker.slots = 0; player.update(); }
  std::vector<int16_t> played;
  for (const auto& request : M5.Speaker.requests) played.insert(played.end(), request.snapshot.begin(), request.snapshot.end());
  assert(played == expected && expected.size() == 120000);

  // Overflow fails cleanly, instead of overwriting queued audio.
  done.clear();
  assert(player.startPcm(start));
  for (unsigned i = 0; i < 26; ++i) assert(player.appendPcm(frame));
  assert(!player.appendPcm(frame));
  assert(!player.busy() && done.size() == 1 && !done.back().second);
  assert(player.startPcm(start));
  assert(player.endPcm(42));
  player.update();
  assert(!done.back().second); // empty stream

  // A pending stream cannot interrupt the current owner, including on cancel.
  SanoTtsVoice dispatcherVoice;
  SpeechDispatcher dispatcher;
  auto dispatchedDone = [&](uint16_t seq, bool ok) {
    dispatcher.finished(seq); done.emplace_back(seq, ok);
  };
  player.begin(avatar, dispatchedDone);
  dispatcherVoice.begin(player, [&](uint16_t seq) { dispatchedDone(seq, false); });
  dispatcher.begin(player, dispatcherVoice, avatar, dispatchedDone);
  done.clear();
  start.seq = 50;
  dispatcher.command(start);
  frame.seq = 50;
  dispatcher.append(frame); dispatcher.append(frame);
  player.update();
  assert(voiceMode == "bridge" && M5.Speaker.slots == 1);
  auto pending = start; pending.seq = 51;
  dispatcher.command(pending);
  frame.seq = 51; dispatcher.append(frame);
  auto end = decode("{\"type\":\"tts.end\",\"seq\":51}");
  dispatcher.command(end);
  assert(done.empty() && player.busy());
  end.seq = 50; dispatcher.command(end);
  while (player.busy()) { M5.Speaker.slots = 0; player.update(); }
  assert(done.size() == 1 && done.back().first == 50 && done.back().second);
  dispatcher.update(); player.update();
  assert(M5.Speaker.slots == 1 && done.size() == 1);
  while (player.busy()) { M5.Speaker.slots = 0; player.update(); }
  assert(done.size() == 2 && done.back().first == 51 && done.back().second);
  start.seq = 52; dispatcher.command(start);
  frame.seq = 52; dispatcher.append(frame); dispatcher.append(frame); player.update();
  pending.seq = 53; dispatcher.command(pending);
  dispatcher.cancel();
  assert(done.size() == 4 && !done[2].second && !done[3].second);
  M5.Speaker.slots = 0; player.update();
  const auto doneBeforeBargeIn = done.size();
  dispatcher.setPaused(true);
  start.seq = 54; dispatcher.command(start);
  assert(!player.busy());
  dispatcher.setPaused(false); dispatcher.update();
  assert(player.busy());
  pending.seq = 55; dispatcher.command(pending);
  dispatcher.cancel(false);
  assert(done.size() == doneBeforeBargeIn && !player.busy());
  faceState = "listening";
  dispatcher.cancel(false);
  assert(faceState == "listening"); // cancelled speech never resets an active mic face
  player.chime(); assert(M5.Speaker.chime);
  player.cancel(false); assert(!M5.Speaker.chime);
  player.begin(avatar, [&](uint16_t seq, bool ok) { done.emplace_back(seq, ok); });
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
  assert(voice.start(46, "こんにちわ"));
  voice.cancel(false); testTask(); voice.update();
  assert(done.size() == 2 && !voice.busy()); // silent barge-in during synthesis
  // PCM arriving during device inference waits for inference and speaker release.
  player.begin(avatar, dispatchedDone);
  dispatcherVoice.begin(player, [&](uint16_t seq) { dispatchedDone(seq, false); });
  done.clear();
  auto kana = decode("{\"type\":\"speak.kana\",\"seq\":60,\"kana\":\"こんにちわ\"}");
  dispatcher.command(kana);
  assert(voiceMode == "device");
  testPullHook = [&] {
    dispatcherVoice.update(); player.update();
    assert(M5.Speaker.slots == 1);
    pending.seq = 61; dispatcher.command(pending);
    frame.seq = 61; dispatcher.append(frame);
    end.seq = 61; dispatcher.command(end);
    dispatcher.update();
    assert(voiceMode == "device" && done.empty());
  };
  testTask();
  dispatcherVoice.update(); dispatcher.update();
  assert(done.size() == 1 && done[0].first == 60 && !done[0].second);
  assert(voiceMode == "device"); // stop remains asynchronous
  M5.Speaker.slots = 0; player.update(); dispatcherVoice.update(); dispatcher.update();
  assert(voiceMode == "bridge");
  player.update();
  while (player.busy()) { M5.Speaker.slots = 0; player.update(); }
  assert(done.size() == 2 && done[1].first == 61 && done[1].second);

  // Kana arriving during PCM is queued, not used to cancel PCM.
  start.seq = 62; dispatcher.command(start);
  frame.seq = 62; dispatcher.append(frame); dispatcher.append(frame); player.update();
  kana.seq = 63; dispatcher.command(kana);
  assert(voiceMode == "bridge" && done.size() == 2);
  end.seq = 62; dispatcher.command(end);
  while (player.busy()) { M5.Speaker.slots = 0; player.update(); }
  dispatcher.update();
  assert(voiceMode == "device" && done.size() == 3 && done.back().second);
  dispatcher.cancel();
  testPullHook = nullptr; testTask(); dispatcherVoice.update();
#endif
  // Real filler cache + player: partial transfer stays silent, cancellation retains speaker memory.
  M5.Speaker.slots = 0; player.update();
  FillerCache fillers;
  SanoTtsVoice cacheVoice;
  player.begin(avatar, [&](uint16_t seq, bool ok) {
    if (!fillers.finished()) done.emplace_back(seq, ok);
  });
  cacheVoice.begin(player, [&](uint16_t seq) { done.emplace_back(seq, false); });
  fillers.begin(player, cacheVoice);
  auto cache = decode(R"({"type":"fillers.set","phrases":[{"kind":"ack","samples":2},{"kind":"wait","samples":2}]})");
  fillers.set(cache.fillers);
  assert(!fillers.ready());
  fillers.ended(8); assert(!player.busy());
  uint8_t fillerBytes[] = {3, 0, 0, 0, 1, 0, 2};
  assert(protocol::decodeBinary(fillerBytes, sizeof(fillerBytes), frame));
  fillers.append(frame); assert(!fillers.ready());
  frame.seq = 1; fillers.append(frame); assert(fillers.ready());
  const auto fillerDoneBefore = done.size();
  fillers.ended(8); player.update(); assert(player.playing() && M5.Speaker.slots == 1);
  M5.Speaker.slots = 0; player.update(); assert(done.size() == fillerDoneBefore);
  fillers.wait(7); assert(!player.busy()); // stale turn
  fillers.wait(8); player.update(); assert(player.busy());
  M5.Speaker.slots = 0; player.update();
  fillers.wait(8); player.update(); assert(player.busy());
  M5.Speaker.slots = 0; player.update();
  fillers.wait(8); assert(!player.busy()); // at most two
  fillers.ended(9); player.update();
  const auto cacheFrees = testFrees;
  fillers.set({}); assert(!fillers.ready() && testFrees == cacheFrees + 1);
  player.update(); assert(testFrees == cacheFrees + 1); // ack still borrowed by async speaker
  M5.Speaker.slots = 0; player.update(); assert(testFrees == cacheFrees + 2);
  fillers.wait(9); assert(!player.busy());
#if DOTS_SANOTTS
  testVoiceSuccess = true;
  auto localCache = decode(R"({"type":"fillers.set","phrases":[{"kind":"ack","kana":"うん"},{"kind":"wait","kana":"まだしらべてるよ"}]})");
  fillers.set(localCache.fillers); fillers.update(false); assert(!cacheVoice.busy());
  fillers.update(true); assert(cacheVoice.busy() && !player.busy());
  testTask(); cacheVoice.update(); assert(!player.busy() && !fillers.ready());
  fillers.update(true); testTask(); cacheVoice.update(); assert(fillers.ready() && !player.busy());
  fillers.ended(10); player.update(); assert(player.busy()); fillers.cancel();
  M5.Speaker.slots = 0; player.update(); fillers.wait(10); assert(!player.busy());
  fillers.set(localCache.fillers); fillers.update(true); fillers.interruptSynthesis();
  testTask(); cacheVoice.update(); fillers.update(true); // interrupted boot synthesis resumes safely
  testTask(); cacheVoice.update(); fillers.update(true); testTask(); cacheVoice.update();
  assert(fillers.ready()); fillers.set({});
  testVoiceSuccess = false;
#endif
  std::cout << "host: protocol/auth, mic release/750-frame cap/overflow/abort/failure, PCM streaming and silent speech interruption passed\n";
}
