#include "protocol.h"

#include <ArduinoJson.h>

namespace dots::protocol {
namespace {
String serialize(JsonDocument& doc) {
  String output;
  serializeJson(doc, output);
  return output;
}
}  // namespace

bool decodeText(const uint8_t* data, size_t length, Command& command) {
  if (!data || !length || length > 8192) return false;
  JsonDocument doc;
  if (deserializeJson(doc, data, length) != DeserializationError::Ok) return false;
  if (!doc.is<JsonObject>() || !doc["type"].is<const char*>()) return false;
  const char* type = doc["type"] | "";
  command = Command{};
  if (!strcmp(type, "welcome")) command.type = CommandType::Welcome;
  else if (!strcmp(type, "voice.mode")) command.type = CommandType::VoiceMode;
  else if (!strcmp(type, "face")) command.type = CommandType::Face;
  else if (!strcmp(type, "look")) command.type = CommandType::Look;
  else if (!strcmp(type, "speak.kana")) command.type = CommandType::SpeakKana;
  else if (!strcmp(type, "tts.start")) command.type = CommandType::TtsStart;
  else if (!strcmp(type, "tts.end")) command.type = CommandType::TtsEnd;
  else if (!strcmp(type, "tts.cancel")) command.type = CommandType::TtsCancel;
  else if (!strcmp(type, "chime")) command.type = CommandType::Chime;
  else if (!strcmp(type, "ping")) command.type = CommandType::Ping;
  else if (!strcmp(type, "pong")) command.type = CommandType::Pong;
  else return false;

  if (command.type == CommandType::VoiceMode &&
      strcmp(doc["mode"] | "", "device") && strcmp(doc["mode"] | "", "bridge")) return false;
  const bool hasSeq = command.type == CommandType::SpeakKana ||
                      command.type == CommandType::TtsStart || command.type == CommandType::TtsEnd;
  if (hasSeq && !doc["seq"].is<uint16_t>()) return false;
  auto validExpression = [](const char* value) {
    return value && (!strcmp(value, "neutral") || !strcmp(value, "happy") ||
        !strcmp(value, "sad") || !strcmp(value, "doubt") ||
        !strcmp(value, "sleepy") || !strcmp(value, "angry"));
  };
  if (command.type == CommandType::Face &&
      !validExpression(doc["expression"].as<const char*>())) return false;
  if (command.type == CommandType::SpeakKana &&
      (!doc["kana"].is<const char*>() || !strlen(doc["kana"]) ||
       strlen(doc["kana"]) > 4096 ||
       (!doc["expression"].isNull() && !validExpression(doc["expression"].as<const char*>())))) return false;
  if (command.type == CommandType::Look &&
      (!doc["pan"].is<float>() || !doc["tilt"].is<float>())) return false;
  if (command.type == CommandType::TtsStart &&
      (!doc["sample_rate"].is<int>() || doc["sample_rate"].as<int>() < 8000 ||
       doc["sample_rate"].as<int>() > 48000 || !doc["channels"].is<int>() ||
       !doc["bits"].is<int>() || doc["channels"].as<int>() != 1 ||
       doc["bits"].as<int>() != 16)) return false;
  if ((command.type == CommandType::Ping || command.type == CommandType::Pong) &&
      !doc["t"].is<uint64_t>()) return false;
  if (command.type == CommandType::Welcome &&
      (!doc["session"].is<const char*>() || !doc["server_time"].is<uint64_t>())) return false;
  if (command.type == CommandType::Chime && strcmp(doc["kind"] | "", "notify")) return false;

  command.seq = doc["seq"] | 0;
  command.sampleRate = doc["sample_rate"] | 0;
  command.channels = doc["channels"] | 0;
  command.bits = doc["bits"] | 0;
  command.pan = doc["pan"] | 0.0f;
  command.tilt = doc["tilt"] | 0.0f;
  command.timestamp = doc["t"] | 0ULL;
  command.text = doc["kana"] | "";
  if (command.type == CommandType::VoiceMode) command.text = doc["mode"] | "";
  command.expression = doc["expression"] | "";
  if (command.type == CommandType::Chime) command.text = doc["kind"] | "";
  return true;
}

String hello(const char* firmware, bool sanotts, bool servo, bool mic) {
  JsonDocument doc;
  doc["type"] = "hello";
  doc["fw"] = firmware;
  doc["caps"]["sanotts"] = sanotts;
  doc["caps"]["servo"] = servo;
  doc["caps"]["mic"] = mic;
  return serialize(doc);
}

String micStart(uint16_t seq) {
  JsonDocument doc;
  doc["type"] = "mic.start";
  doc["seq"] = seq;
  doc["sample_rate"] = 16000;
  return serialize(doc);
}
String micEnd(uint16_t seq, const char* reason) {
  JsonDocument doc;
  doc["type"] = "mic.end";
  doc["seq"] = seq;
  doc["reason"] = reason;
  return serialize(doc);
}

String state(const char* value) {
  JsonDocument doc;
  doc["type"] = "state";
  doc["state"] = value;
  return serialize(doc);
}

String event(const char* kind, const String& where) {
  JsonDocument doc;
  doc["type"] = "event";
  doc["kind"] = kind;
  if (!where.isEmpty()) doc["where"] = where;
  return serialize(doc);
}

String ttsDone(uint16_t seq, bool ok) {
  JsonDocument doc;
  doc["type"] = "tts.done";
  doc["seq"] = seq;
  doc["ok"] = ok;
  return serialize(doc);
}

String pong(uint64_t timestamp) {
  JsonDocument doc;
  doc["type"] = "pong";
  doc["t"] = timestamp;
  return serialize(doc);
}

}  // namespace dots::protocol
