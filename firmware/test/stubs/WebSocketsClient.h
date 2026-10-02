#pragma once
#include <functional>
#include <string>
#include <vector>
#include "Arduino.h"
enum WStype_t { WStype_CONNECTED, WStype_DISCONNECTED, WStype_TEXT, WStype_BIN };
class WebSocketsClient {
 public:
  static inline WebSocketsClient* instance = nullptr;
  std::function<void(WStype_t, uint8_t*, size_t)> handler;
  std::string headers;
  std::vector<std::string> sent;
  unsigned starts = 0;
  bool verified = false;
  WebSocketsClient() { instance = this; }
  void onEvent(decltype(handler) value) { handler = std::move(value); }
  void setReconnectInterval(unsigned) {}
  void enableHeartbeat(unsigned, unsigned, unsigned) {}
  void setExtraHeaders(const char* value) { headers = value; }
  void begin(const char*, uint16_t, const char*) { ++starts; }
  void beginSSL(const char* host, uint16_t port, const char* path) { begin(host, port, path); }
  void beginSslWithCA(const char* host, uint16_t port, const char* path, const char* root) {
    verified = std::string(root).find("BEGIN CERTIFICATE") != std::string::npos;
    begin(host, port, path);
  }
  void disconnect() { handler(WStype_DISCONNECTED, nullptr, 0); }
  void loop() {}
  bool sendTXT(String& value) { sent.push_back(value); return true; }
};
