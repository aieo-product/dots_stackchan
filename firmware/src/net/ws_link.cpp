#include "net/ws_link.h"

#include <mbedtls/md.h>
#include <time.h>

#include "net/tls_roots.h"
#include "net/endpoint.h"
#include "protocol_frame.h"

#ifndef DOTS_TLS_VERIFY
#define DOTS_TLS_VERIFY 1
#endif

namespace dots {
namespace {
constexpr uint32_t kReconnectMs = 5000;

bool hmacSha256(const String& key, const String& message, char output[65]) {
  uint8_t digest[32];
  mbedtls_md_context_t context;
  mbedtls_md_init(&context);
  const mbedtls_md_info_t* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  const bool ok = info && mbedtls_md_setup(&context, info, 1) == 0 &&
      mbedtls_md_hmac_starts(&context, reinterpret_cast<const uint8_t*>(key.c_str()), key.length()) == 0 &&
      mbedtls_md_hmac_update(&context, reinterpret_cast<const uint8_t*>(message.c_str()), message.length()) == 0 &&
      mbedtls_md_hmac_finish(&context, digest) == 0;
  mbedtls_md_free(&context);
  if (!ok) return false;
  for (size_t i = 0; i < sizeof(digest); ++i) snprintf(output + i * 2, 3, "%02x", digest[i]);
  output[64] = '\0';
  return true;
}
}  // namespace

void WsLink::begin(const DeviceConfig& config, TextHandler textHandler,
                   BinaryHandler binaryHandler, StatusHandler statusHandler) {
  config_ = &config;
  textHandler_ = std::move(textHandler);
  binaryHandler_ = std::move(binaryHandler);
  statusHandler_ = std::move(statusHandler);
  socket_.onEvent([this](WStype_t type, uint8_t* payload, size_t length) {
    handleEvent(type, payload, length);
  });
  socket_.setReconnectInterval(kReconnectMs);
  socket_.enableHeartbeat(15000, 30000, 2);
}

bool WsLink::parseEndpoint(const String& url) {
  net::Endpoint parsed;
  if (!net::parseEndpoint(url.c_str(), parsed)) return false;
  endpoint_.host = parsed.host.c_str();
  endpoint_.path = parsed.path.c_str();
  endpoint_.port = parsed.port;
  endpoint_.tls = parsed.tls;
  return true;
}

bool WsLink::updateHeaders() {
  const time_t now = time(nullptr);
  if (now < 1577836800 || !config_ || config_->psk.isEmpty() ||
      config_->deviceId.isEmpty()) {
    return false;
  }
  const String timestamp(static_cast<unsigned long>(now));
  const String signedValue = config_->deviceId + ":" + timestamp;
  char digest[65];
  if (!hmacSha256(config_->psk, signedValue, digest)) return false;
  headers_ = "X-Device-Id: " + config_->deviceId + "\r\nX-Timestamp: " +
             timestamp + "\r\nX-Auth: " + digest;
  socket_.setExtraHeaders(headers_.c_str());
  return true;
}

void WsLink::start() {
  if (!config_ || config_->server.isEmpty() || !parseEndpoint(config_->server) ||
      !updateHeaders()) {
    return;
  }
  if (endpoint_.tls) {
#if DOTS_TLS_VERIFY
    socket_.beginSslWithCA(endpoint_.host.c_str(), endpoint_.port,
                           endpoint_.path.c_str(), kIsrgRootX1);
#else
    socket_.beginSSL(endpoint_.host.c_str(), endpoint_.port, endpoint_.path.c_str());
#endif
  } else {
    socket_.begin(endpoint_.host.c_str(), endpoint_.port, endpoint_.path.c_str());
  }
  started_ = true;
  Serial.printf("[ws] connecting (%s, TLS verification %s)\n",
                endpoint_.tls ? "wss" : "ws",
                endpoint_.tls && DOTS_TLS_VERIFY ? "on" : "off");
}

void WsLink::update(bool wifiConnected) {
  // Mic TX may be stalled in a socket write. Keep local input/audio responsive.
  SocketGuard guard(lock_, true);
  if (!guard.locked()) return;
  if (!wifiConnected) {
    if (started_) socket_.disconnect();
    started_ = false;
    if (connected_) handleEvent(WStype_DISCONNECTED, nullptr, 0);
    retryAt_ = millis() - kReconnectMs;
    return;
  }
  if (!started_ && millis() - retryAt_ >= kReconnectMs) {
    retryAt_ = millis();
    start();
  }
  // Each failed handshake must use a fresh timestamp, including after long outages.
  if (started_) {
    if (!connected_ && !updateHeaders()) return;
    socket_.loop();
  }
}

bool WsLink::send(const String& text, const std::atomic<bool>* cancelled, bool nonblocking) {
  SocketGuard guard(lock_, nonblocking);
  if (!guard.locked()) return false;
  String mutableText(text);
  return connected_ && (!cancelled || !cancelled->load()) && socket_.sendTXT(mutableText);
}

bool WsLink::sendBinary(uint8_t* data, size_t length, const std::atomic<bool>* cancelled) {
  SocketGuard guard(lock_);
  return connected_ && (!cancelled || !cancelled->load()) && data && length >= 3 &&
      length <= protocol::kMaxBinaryFrameBytes && socket_.sendBIN(data, length);
}

void WsLink::handleEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      connected_ = true;
      Serial.println("[ws] connected");
      if (statusHandler_) statusHandler_(true);
      break;
    case WStype_DISCONNECTED:
      if (connected_) {
        connected_ = false;
        Serial.println("[ws] disconnected");
        if (statusHandler_) statusHandler_(false);
      }
      // Refresh the timestamp and HMAC before the library's next retry.
      updateHeaders();
      break;
    case WStype_TEXT:
      if (textHandler_) textHandler_(payload, length);
      break;
    case WStype_BIN:
      if (binaryHandler_) binaryHandler_(payload, length);
      break;
    default:
      break;
  }
}

}  // namespace dots
