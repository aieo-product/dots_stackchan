#pragma once

#include <Arduino.h>
#include <WebSocketsClient.h>
#include <functional>

#include "config_store.h"

namespace dots {

class WsLink {
 public:
  using TextHandler = std::function<void(const uint8_t*, size_t)>;
  using BinaryHandler = std::function<void(const uint8_t*, size_t)>;
  using StatusHandler = std::function<void(bool)>;

  void begin(const DeviceConfig& config, TextHandler textHandler,
             BinaryHandler binaryHandler, StatusHandler statusHandler);
  void update(bool wifiConnected);
  bool connected() const { return connected_; }
  bool send(const String& text);

 private:
  struct Endpoint {
    String host;
    String path;
    uint16_t port = 0;
    bool tls = false;
  };

  WebSocketsClient socket_;
  const DeviceConfig* config_ = nullptr;
  TextHandler textHandler_;
  BinaryHandler binaryHandler_;
  StatusHandler statusHandler_;
  Endpoint endpoint_;
  bool started_ = false;
  bool connected_ = false;
  uint32_t retryAt_ = 0;
  String headers_;

  bool parseEndpoint(const String& url);
  bool updateHeaders();
  void start();
  void handleEvent(WStype_t type, uint8_t* payload, size_t length);
};

}  // namespace dots
