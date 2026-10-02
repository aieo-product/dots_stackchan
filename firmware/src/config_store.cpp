#include "config_store.h"

#include <Preferences.h>
#include "net/endpoint.h"
#include <esp_system.h>

namespace dots {
namespace {
constexpr const char* kNamespace = "dots";

String generatedDeviceId() {
  const uint64_t chip = ESP.getEfuseMac();
  char id[20];
  snprintf(id, sizeof(id), "dots-%08lx", static_cast<unsigned long>(chip));
  return String(id);
}
}  // namespace

bool ConfigStore::begin() {
  Preferences prefs;
  if (!prefs.begin(kNamespace, false)) return false;
  config_.server = prefs.getString("server", "");
  config_.ntp = prefs.getString("ntp", "");
  config_.psk = prefs.getString("psk", "");
  config_.deviceId = prefs.getString("device", "");
  config_.panServoId = prefs.getUChar("pan_id", DOTS_SERVO_PAN_ID);
  config_.tiltServoId = prefs.getUChar("tilt_id", DOTS_SERVO_TILT_ID);
  config_.servoTxPin = prefs.getUChar("servo_tx", DOTS_SERVO_TX_PIN);
  config_.servoRxPin = prefs.getUChar("servo_rx", DOTS_SERVO_RX_PIN);
  config_.wifiCount = min(static_cast<size_t>(prefs.getUChar("wifi_n", 0)),
                          kMaxWifiProfiles);
  for (size_t i = 0; i < config_.wifiCount; ++i) {
    const String suffix(i);
    config_.wifi[i].ssid = prefs.getString(("ws" + suffix).c_str(), "");
    config_.wifi[i].password = prefs.getString(("wp" + suffix).c_str(), "");
  }
  if (config_.deviceId.isEmpty()) {
    config_.deviceId = generatedDeviceId();
    prefs.putString("device", config_.deviceId);
  }
  prefs.end();
  return true;
}

bool ConfigStore::saveWifi() {
  Preferences prefs;
  if (!prefs.begin(kNamespace, false)) return false;
  bool ok = prefs.putUChar("wifi_n", config_.wifiCount) == sizeof(uint8_t);
  for (size_t i = 0; i < kMaxWifiProfiles; ++i) {
    const String suffix(i);
    prefs.remove(("ws" + suffix).c_str());
    prefs.remove(("wp" + suffix).c_str());
    if (i < config_.wifiCount) {
      ok &= prefs.putString(("ws" + suffix).c_str(), config_.wifi[i].ssid) > 0;
      prefs.putString(("wp" + suffix).c_str(), config_.wifi[i].password);
    }
  }
  prefs.end();
  return ok;
}

bool ConfigStore::addWifi(const String& ssid, const String& password) {
  if (ssid.isEmpty()) return false;
  for (size_t i = 0; i < config_.wifiCount; ++i) {
    if (config_.wifi[i].ssid == ssid) {
      config_.wifi[i].password = password;
      return saveWifi();
    }
  }
  if (config_.wifiCount >= kMaxWifiProfiles) {
    for (size_t i = 1; i < kMaxWifiProfiles; ++i) config_.wifi[i - 1] = config_.wifi[i];
    --config_.wifiCount;
  }
  config_.wifi[config_.wifiCount++] = {ssid, password};
  return saveWifi();
}

bool ConfigStore::clearWifi() {
  config_.wifiCount = 0;
  return saveWifi();
}

bool ConfigStore::setServer(const String& value) {
  net::Endpoint endpoint;
  if (!net::parseEndpoint(value.c_str(), endpoint)) return false;
  Preferences prefs;
  if (!prefs.begin(kNamespace, false)) return false;
  config_.server = value;
  const bool ok = prefs.putString("server", value) > 0;
  prefs.end();
  return ok;
}

bool ConfigStore::setPsk(const String& value) {
  if (value.length() < 16 || value.length() > 128 || value.length() % 2) return false;
  for (size_t i = 0; i < value.length(); ++i) if (!isxdigit(value[i])) return false;
  Preferences prefs;
  if (!prefs.begin(kNamespace, false)) return false;
  config_.psk = value;
  const bool ok = prefs.putString("psk", value) > 0;
  prefs.end();
  return ok;
}

bool ConfigStore::setDeviceId(const String& value) {
  if (value.isEmpty() || value.length() > 64) return false;
  for (size_t i = 0; i < value.length(); ++i) {
    if (!isalnum(value[i]) && value[i] != '-' && value[i] != '_') return false;
  }
  Preferences prefs;
  if (!prefs.begin(kNamespace, false)) return false;
  config_.deviceId = value;
  const bool ok = prefs.putString("device", value) > 0;
  prefs.end();
  return ok;
}

bool ConfigStore::setServo(uint8_t panId, uint8_t tiltId, uint8_t txPin,
                           uint8_t rxPin) {
  if (!panId || !tiltId || txPin == rxPin) return false;
  Preferences prefs;
  if (!prefs.begin(kNamespace, false)) return false;
  config_.panServoId = panId;
  config_.tiltServoId = tiltId;
  config_.servoTxPin = txPin;
  config_.servoRxPin = rxPin;
  bool ok = prefs.putUChar("pan_id", panId) == sizeof(uint8_t);
  ok &= prefs.putUChar("tilt_id", tiltId) == sizeof(uint8_t);
  ok &= prefs.putUChar("servo_tx", txPin) == sizeof(uint8_t);
  ok &= prefs.putUChar("servo_rx", rxPin) == sizeof(uint8_t);
  prefs.end();
  return ok;
}

bool ConfigStore::setNtp(const String& value) {
  if (value.isEmpty() || value.length() > 253) return false;
  for (size_t i = 0; i < value.length(); ++i) {
    if (!isalnum(value[i]) && value[i] != '-' && value[i] != '.') return false;
  }
  Preferences prefs;
  if (!prefs.begin(kNamespace, false)) return false;
  const bool ok = prefs.putString("ntp", value) > 0;
  if (ok) config_.ntp = value;
  return ok;
}

String masked(const String& value) {
  if (value.isEmpty()) return "<unset>";
  return "<set>";
}

}  // namespace dots
