#include "app.h"
#include <M5Unified.h>
#include "audio/player.h"
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
ScsServo servo;
DeviceInput input;
Microphone mic;
bool pttHeld = false;
bool pttPending = false;
bool pendingChime = false;

void done(uint16_t seq, bool ok) { speech.finished(seq); ws.send(protocol::ttsDone(seq, ok)); }
void cancel() { mic.abort(); pttPending = pendingChime = false; speech.cancel(); }
void ptt(bool held) {
  pttHeld = held;
  if (held) {
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
    case CommandType::TtsStart:
    case CommandType::TtsEnd:
    case CommandType::TtsCancel:
    case CommandType::SpeakKana: speech.command(command); break;
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
  face.onState([](const char* state) { ws.send(protocol::state(state)); });
  player.begin(face, done);
  voice.begin(player, [](uint16_t seq) { done(seq, false); });
  speech.begin(player, voice, face, done);
  mic.begin(ws, face);
  face.setVoiceMode(voice.available() ? "device" : "bridge");
  servo.begin(config.get());
  wifi.begin(config.get());
  if (!config.get().ntp.isEmpty()) configTime(0, 0, config.get().ntp.c_str());
  ws.begin(config.get(), onText,
      [](const uint8_t* data, size_t length) {
        protocol::BinaryFrame frame;
        if (protocol::decodeBinary(data, length, frame)) speech.append(frame);
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
  ws.update(wifi.connected());
  input.update();
  voice.update();
  mic.update();
  if (!mic.busy()) player.update();
  if (pttPending && !mic.busy() && !voice.busy() && !player.busy()) {
    pttPending = false;
    if (pttHeld) mic.start();
  }
  speech.setPaused(pttPending || mic.busy());
  speech.update();
  if (pendingChime && !pttPending && !mic.busy()) {
    pendingChime = false;
    player.chime();
  }
  face.update();
}
}
