#pragma once
#include <functional>
#include "face/face.h"
namespace dots {
class DeviceInput {
 public:
  void begin(FaceController& face, std::function<void(const char*, const String&)> handler,
             std::function<void(bool)> pttHandler);
  void update();
  void showCredits(bool show) { credits_ = show; face_->showCredits(show); }
 private:
  FaceController* face_ = nullptr;
  std::function<void(const char*, const String&)> handler_;
  std::function<void(bool)> pttHandler_;
  bool held_ = false;
  bool credits_ = false;
};
}
