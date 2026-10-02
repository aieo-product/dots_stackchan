#include "input.h"
#include <M5Unified.h>
namespace dots {
void DeviceInput::begin(FaceController& face, std::function<void(const char*, const String&)> handler,
                        std::function<void(bool)> pttHandler) {
  face_ = &face;
  handler_ = std::move(handler);
  pttHandler_ = std::move(pttHandler);
}
void DeviceInput::update() {
  if (M5.BtnB.wasPressed()) handler_("button", "B");
  if (M5.BtnC.wasPressed()) handler_("button", "C");
  if (M5.BtnB.wasHold()) {
    credits_ = !credits_;
    face_->showCredits(credits_);
  }
  bool held = M5.BtnA.isPressed();
  for (size_t i = 0; i < M5.Touch.getCount(); ++i) {
    const auto touch = M5.Touch.getDetail(i);
    held |= touch.isPressed();
  }
  if (held != held_) {
    held_ = held;
    if (held) { credits_ = false; face_->showCredits(false); }
    pttHandler_(held);
  }
}
}
