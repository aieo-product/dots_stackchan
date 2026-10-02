#pragma once
#include <functional>
#include "face/face.h"
namespace dots {
class DeviceInput {
 public:
  void begin(FaceController& face, std::function<void(const char*, const String&)> handler);
  void update();
 private:
  FaceController* face_ = nullptr;
  std::function<void(const char*, const String&)> handler_;
  bool credits_ = false;
};
}
