#include "app.h"
#include <M5Unified.h>
#include "audio/player.h"
#include "audio/fillers.h"
#include "audio/sanotts_voice.h"
#include "audio/speech_dispatcher.h"
#include "audio/mic.h"
#include "cli.h"
#include "input.h"
#include "net/wifi_link.h"
#include "net/ws_link.h"
#include "servo/scs.h"

namespace dots {
namespace {
ConfigStore config;
SerialCli cli;
WifiLink wifi;
WsLink ws;
FaceController face;
AudioPlayer player;
SanoTtsVoice voice;
SpeechDispatcher speech;
FillerCache fillers;
ScsServo servo;
DeviceInput input;
Microphone mic;
bool pttHeld = false;
bool pttPending = false;
bool pendingChime = false;
String pendingState;

void done(uint16_t seq, bool ok) { if (fillers.finished()) return; speech.finished(seq); ws.send(protocol::ttsDone(seq, ok)); }
void cancel() { fillers.cancel(); fillers.interruptSynthesis(); mic.abort(); pttPending = pendingChime = false; speech.cancel(); }
void ptt(bool held) {
  pttHeld = held;
  if (held) {
    fillers.cancel(); fillers.interruptSynthesis();
    speech.setPaused(true);
    speech.cancel(false); // Local barge-in sends no tts.done or input event.
    pendingChime = false;
    pttPending = true;
  } else {
    pttPending = false;
    mic.release();
  }
}
void onText(const uint8_t* data, size_t length) {
  protocol::Command command;
  if (!protocol::decodeText(data, length, command)) return;
  using protocol::CommandType;
  switch (command.type) {
    case CommandType::VoiceMode: face.setVoiceMode(command.text.c_str()); break;
    case CommandType::Face: face.setExpression(command.expression); break;
    case CommandType::Look: servo.look(command.pan, command.tilt); break;
    case CommandType::FillersSet: fillers.set(command.fillers); break;
    case CommandType::FillersPlay:
      if (!mic.capturing() && !pttPending) fillers.wait(command.seq);
      break;
    case CommandType::FillersCancel: fillers.cancel(); break;
    case CommandType::TtsStart:
    case CommandType::TtsCancel:
    case CommandType::SpeakKana:
      fillers.cancel(); fillers.interruptSynthesis();
      speech.command(command); break;
    case CommandType::TtsEnd: speech.command(command); break;
    case CommandType::Chime:
      if (mic.busy() || pttPending) pendingChime = true;
      else player.chime();
      break;
    case CommandType::Ping: ws.send(protocol::pong(command.timestamp)); break;
    default: break;
  }
}
}
void begin() {
  config.begin();
  cli.begin(config);
  face.begin();
  face.onState([](const char* state) { pendingState = state; });
  player.begin(face, done);
  voice.begin(player, [](uint16_t seq) { done(seq, false); });
  speech.begin(player, voice, face, done);
  mic.begin(ws, face);
  fillers.begin(player, voice);
  mic.onEnd([](uint16_t seq) { fillers.ended(seq); });
  face.setVoiceMode(voice.available() ? "device" : "bridge");
  servo.begin(config.get());
  wifi.begin(config.get());
  if (!config.get().ntp.isEmpty()) configTime(0, 0, config.get().ntp.c_str());
  ws.begin(config.get(), onText,
      [](const uint8_t* data, size_t length) {
        protocol::BinaryFrame frame;
        if (protocol::decodeBinary(data, length, frame)) {
          if (frame.kind == 0x03) fillers.append(frame);
          else speech.append(frame);
        }
      },
      [](bool online) {
        face.setOnline(online);
        if (online) {
          ws.send(protocol::hello(DOTS_FW_VERSION, voice.available(), servo.available(), mic.available()));
          ws.send(protocol::state("idle"));
        } else cancel();
      });
  input.begin(face, [](const char* kind, const String& where) {
    ws.send(protocol::event(kind, where));
  }, ptt);
  cli.onCredits([](bool show) { input.showCredits(show); });
  Serial.println("dots ready; status, wifi:, server:, psk:, ntp:, time:, reboot");
}
void update() {
  cli.update();
  wifi.update();
  input.update();
  voice.update();
  mic.update();
  if (!mic.capturing()) player.update();
  if (pttPending && !mic.busy() && !voice.busy() && !player.busy()) {
    pttPending = false;
    if (pttHeld) mic.start();
  }
  speech.setPaused(pttPending || mic.busy());
  speech.update();
  fillers.update(!pttHeld && !pttPending && !mic.busy());
  if (pendingChime && !pttPending && !mic.busy()) {
    pendingChime = false;
    player.chime();
  }
  face.update();
  // Local capture completion and first audio precede network work. State reports
  // are deferred while TX drains, so a stalled upload cannot block the filler.
  if ((!mic.busy() || mic.capturing()) && !pendingState.isEmpty()) {
    if (ws.send(protocol::state(pendingState.c_str()), nullptr, true)) pendingState = "";
  }
  ws.update(wifi.connected());
}
}
