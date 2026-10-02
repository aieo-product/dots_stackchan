#pragma once
#include <cstdint>
#include <string>
namespace dots::net {
struct Endpoint {
  std::string host;
  std::string path;
  uint16_t port = 0;
  bool tls = false;
};
inline bool parseEndpoint(const std::string& url, Endpoint& output) {
  Endpoint endpoint;
  const size_t start = url.compare(0, 6, "wss://") == 0 ? 6 :
                       url.compare(0, 5, "ws://") == 0 ? 5 : 0;
  if (!start) return false;
  endpoint.tls = start == 6;
  const auto slash = url.find('/', start);
  const auto authority = url.substr(start, slash == std::string::npos ? slash : slash - start);
  if (authority.empty()) return false;
  const auto colon = authority.find(':');
  endpoint.host = authority.substr(0, colon);
  if (endpoint.host.empty()) return false;
  for (const unsigned char ch : endpoint.host) {
    if (!((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
          (ch >= '0' && ch <= '9') || ch == '.' || ch == '-')) return false;
  }
  unsigned port = endpoint.tls ? 443 : 80;
  if (colon != std::string::npos) {
    port = 0;
    if (colon + 1 == authority.size()) return false;
    for (size_t i = colon + 1; i < authority.size(); ++i) {
      if (authority[i] < '0' || authority[i] > '9') return false;
      port = port * 10 + authority[i] - '0';
      if (port > 65535) return false;
    }
    if (!port) return false;
  }
  endpoint.port = port;
  endpoint.path = slash == std::string::npos ? "/device" : url.substr(slash);
  if (endpoint.path != "/device") return false;
  output = endpoint;
  return true;
}
}
