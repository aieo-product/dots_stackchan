#pragma once

#include <Arduino.h>
#include <vector>
#include "protocol_frame.h"

namespace dots::protocol {

enum class CommandType {
  Unknown,
  Welcome,
  VoiceMode,
  Face,
  Look,
  SpeakKana,
  TtsStart,
  TtsEnd,
  TtsCancel,
  Chime,
  FillersSet,
  FillersPlay,
  FillersCancel,
  Ping,
  Pong,
};

struct FillerPhrase {
  String kana;
  bool wait = false;
  size_t samples = 0;
};

struct Command {
  CommandType type = CommandType::Unknown;
  uint16_t seq = 0;
  int sampleRate = 0;
  int channels = 0;
  int bits = 0;
  float pan = 0;
  float tilt = 0;
  uint64_t timestamp = 0;
  String text;
  String expression;
  std::vector<FillerPhrase> fillers;
};

bool decodeText(const uint8_t* data, size_t length, Command& command);
String hello(const char* firmware, bool sanotts, bool servo, bool mic = false);
String micStart(uint16_t seq);
String micEnd(uint16_t seq, const char* reason);
String state(const char* value);
String event(const char* kind, const String& where = "");
String ttsDone(uint16_t seq, bool ok);
String pong(uint64_t timestamp);

}  // namespace dots::protocol
