#include "input.h"
#include <M5Unified.h>
namespace dots {
void DeviceInput::begin(FaceController& face, std::function<void(const char*, const String&)> handler) {
  face_ = &face;
  handler_ = std::move(handler);
}
void DeviceInput::update() {
  if (M5.BtnA.wasPressed()) handler_("button", "A");
  if (M5.BtnB.wasPressed()) handler_("button", "B");
  if (M5.BtnC.wasPressed()) handler_("button", "C");
  for (size_t i = 0; i < M5.Touch.getCount(); ++i) {
    const auto touch = M5.Touch.getDetail(i);
    if (touch.wasPressed()) handler_("touch", String(touch.x) + "," + String(touch.y));
    if (touch.wasHold()) {
      credits_ = !credits_;
      face_->showCredits(credits_);
    }
  }
}
}
