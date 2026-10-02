#include "net/wifi_link.h"

#include <WiFi.h>

namespace dots {
namespace {
constexpr uint32_t kAttemptMs = 12000;
constexpr uint32_t kRetryMs = 5000;
}

void WifiLink::begin(const DeviceConfig& config) {
  config_ = &config;
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  reconnect();
}

bool WifiLink::connected() const { return WiFi.status() == WL_CONNECTED; }

void WifiLink::reconnect() {
  WiFi.disconnect();
  profile_ = 0;
  attempting_ = false;
  retryAt_ = 0;
}

void WifiLink::startNext() {
  if (!config_ || !config_->wifiCount) return;
  const WifiProfile& profile = config_->wifi[profile_ % config_->wifiCount];
  profile_ = (profile_ + 1) % config_->wifiCount;
  WiFi.begin(profile.ssid.c_str(), profile.password.c_str());
  attemptStarted_ = millis();
  attempting_ = true;
  Serial.printf("[wifi] trying profile %u/%u\n", static_cast<unsigned>(profile_),
                static_cast<unsigned>(config_->wifiCount));
}

void WifiLink::update() {
  if (connected()) {
    attempting_ = false;
    return;
  }
  const uint32_t now = millis();
  if (attempting_ && now - attemptStarted_ < kAttemptMs) return;
  if (attempting_) {
    WiFi.disconnect();
    attempting_ = false;
    retryAt_ = now + (profile_ == 0 ? kRetryMs : 0);
  }
  if (!config_ || !config_->wifiCount || static_cast<int32_t>(now - retryAt_) < 0) return;
  startNext();
}

}  // namespace dots
