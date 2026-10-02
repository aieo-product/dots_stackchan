#pragma once

#include <Arduino.h>

#include "config_store.h"

namespace dots {

class ScsServo {
 public:
  void begin(const DeviceConfig& config);
  void look(float panDegrees, float tiltDegrees);
  bool available() const { return available_; }

 private:
  HardwareSerial bus_{1};
  uint8_t panId_ = 0;
  uint8_t tiltId_ = 0;
  bool available_ = false;
  void writePosition(uint8_t id, uint16_t position, uint16_t timeMs);
};

}  // namespace dots
