#include "face/face.h"

#include <M5Unified.h>
#include "face/credits.h"

namespace dots {
using m5avatar::Expression;

void FaceController::begin() {
  avatar_.setExpression(Expression::Neutral);
  avatar_.init();
  drawStatus();
}

bool FaceController::setExpression(const String& name) {
  if (name == "neutral") avatar_.setExpression(Expression::Neutral);
  else if (name == "happy") avatar_.setExpression(Expression::Happy);
  else if (name == "sad") avatar_.setExpression(Expression::Sad);
  else if (name == "doubt") avatar_.setExpression(Expression::Doubt);
  else if (name == "sleepy") avatar_.setExpression(Expression::Sleepy);
  else if (name == "angry") avatar_.setExpression(Expression::Angry);
  else return false;
  expressionOverride_ = true;
  return true;
}

void FaceController::applyStateExpression() {
  if (expressionOverride_) return;
  if (state_ == "speaking" || state_ == "notifying") {
    avatar_.setExpression(Expression::Happy);
  } else if (state_ == "thinking" || state_ == "listening") {
    avatar_.setExpression(Expression::Doubt);
  } else {
    avatar_.setExpression(Expression::Neutral);
  }
}

void FaceController::setState(const char* state) {
  if (state_ == state) return;
  state_ = state;
  if (state_ == "idle") expressionOverride_ = false;
  if (!credits_) { applyStateExpression(); drawStatus(); }
  if (stateHandler_) stateHandler_(state);
}

void FaceController::setOnline(bool online) {
  online_ = online;
  if (!credits_) drawStatus();
}

void FaceController::setMouth(float ratio) {
  avatar_.setMouthOpenRatio(constrain(ratio, 0.0f, 1.0f));
}

void FaceController::setVoiceMode(const char* mode) {
  voiceMode_ = mode;
  if (!credits_) drawStatus();
}

void FaceController::drawStatus() {
  const String status = String(online_ ? "online" : "offline") + " / " + voiceMode_ + " / " + state_;
  avatar_.setSpeechText(status.c_str());
}

void FaceController::drawCredits() {
  M5.Display.fillScreen(TFT_BLACK);
  M5.Display.setTextColor(TFT_WHITE, TFT_BLACK);
  M5.Display.setTextDatum(top_left);
  M5.Display.setFont(&fonts::efontJA_10);
  M5.Display.setTextWrap(true);
  M5.Display.setCursor(8, 8);
  M5.Display.println("Credits (hold B to return)");
  const String text(kModelCredits);
  int from = 0;
  for (unsigned line = 0; line < creditsPage_ * 4 && from < text.length(); ++line) {
    const int end = text.indexOf('\n', from);
    from = end < 0 ? text.length() : end + 1;
  }
  for (unsigned line = 0; line < 4 && from < text.length(); ++line) {
    const int end = text.indexOf('\n', from);
    M5.Display.println(text.substring(from, end < 0 ? text.length() : end));
    from = end < 0 ? text.length() : end + 1;
  }
  creditsPage_ = from >= text.length() ? 0 : creditsPage_ + 1;
  statusAt_ = millis();
}

void FaceController::showCredits(bool show) {
  if (credits_ == show) return;
  credits_ = show;
  if (credits_) {
    creditsPage_ = 0;
    avatar_.suspend();
    drawCredits();
  } else {
    M5.Display.setFont(&fonts::Font0);
    avatar_.resume();
    applyStateExpression();
    drawStatus();
  }
}

void FaceController::update() {
  if (credits_) {
    if (millis() - statusAt_ >= 8000) drawCredits();
    return;
  }
  if (millis() - statusAt_ >= 1000) {
    statusAt_ = millis();
    drawStatus();
  }
}

}  // namespace dots
