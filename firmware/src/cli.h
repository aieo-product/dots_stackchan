#pragma once
#include <Arduino.h>
#include "config_store.h"

namespace dots {
class SerialCli {
 public:
  void begin(ConfigStore& store) { store_ = &store; }
  void update();
 private:
  ConfigStore* store_ = nullptr;
  String line_;
  bool overflow_ = false;
  void execute();
};
}
