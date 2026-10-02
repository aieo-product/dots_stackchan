#pragma once
#include <Arduino.h>
#include <functional>
#include "config_store.h"

namespace dots {
class SerialCli {
 public:
  void begin(ConfigStore& store) { store_ = &store; }
  void update();
  void onCredits(std::function<void(bool)> handler) { creditsHandler_ = std::move(handler); }
 private:
  ConfigStore* store_ = nullptr;
  String line_;
  bool overflow_ = false;
  std::function<void(bool)> creditsHandler_;
  void execute();
};
}
