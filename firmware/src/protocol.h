#pragma once

#include <Arduino.h>
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
  Ping,
  Pong,
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
};

bool decodeText(const uint8_t* data, size_t length, Command& command);
String hello(const char* firmware, bool sanotts, bool servo);
String state(const char* value);
String event(const char* kind, const String& where = "");
String ttsDone(uint16_t seq, bool ok);
String pong(uint64_t timestamp);

}  // namespace dots::protocol
