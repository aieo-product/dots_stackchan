#pragma once

#include <Arduino.h>
#include <Avatar.h>
#include <functional>

namespace dots {

class FaceController {
 public:
  void begin();
  bool setExpression(const String& name);
  void setState(const char* state);
  void onState(std::function<void(const char*)> handler) { stateHandler_ = std::move(handler); }
  void setOnline(bool online);
  void setMouth(float ratio);
  void showCredits(bool show);
  void update();

 private:
  m5avatar::Avatar avatar_;
  String state_ = "idle";
  bool online_ = false;
  bool credits_ = false;
  bool expressionOverride_ = false;
  uint32_t statusAt_ = 0;
  unsigned creditsPage_ = 0;
  std::function<void(const char*)> stateHandler_;
  void applyStateExpression();
  void drawStatus();
  void drawCredits();
};

}  // namespace dots
