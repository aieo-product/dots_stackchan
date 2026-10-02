#pragma once

#include <Arduino.h>
#include "hardware_config.h"

namespace dots {

constexpr size_t kMaxWifiProfiles = 5;

struct WifiProfile {
  String ssid;
  String password;
};

struct DeviceConfig {
  WifiProfile wifi[kMaxWifiProfiles];
  size_t wifiCount = 0;
  String server;
  String psk;
  String deviceId;
  String ntp;
  uint8_t panServoId = DOTS_SERVO_PAN_ID;
  uint8_t tiltServoId = DOTS_SERVO_TILT_ID;
  uint8_t servoTxPin = DOTS_SERVO_TX_PIN;
  uint8_t servoRxPin = DOTS_SERVO_RX_PIN;
};

class ConfigStore {
 public:
  bool begin();
  const DeviceConfig& get() const { return config_; }
  bool addWifi(const String& ssid, const String& password);
  bool clearWifi();
  bool setServer(const String& value);
  bool setPsk(const String& value);
  bool setNtp(const String& value);
  bool setDeviceId(const String& value);
  bool setServo(uint8_t panId, uint8_t tiltId, uint8_t txPin, uint8_t rxPin);

 private:
  DeviceConfig config_;
  bool saveWifi();
};

String masked(const String& value);

}  // namespace dots
