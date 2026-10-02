#pragma once

#include <Arduino.h>

#include "config_store.h"

namespace dots {

class WifiLink {
 public:
  void begin(const DeviceConfig& config);
  void update();
  bool connected() const;
  void reconnect();

 private:
  const DeviceConfig* config_ = nullptr;
  size_t profile_ = 0;
  uint32_t attemptStarted_ = 0;
  uint32_t retryAt_ = 0;
  bool attempting_ = false;
  void startNext();
};

}  // namespace dots
