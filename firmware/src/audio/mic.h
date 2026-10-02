#pragma once
#include <atomic>
#include <M5Unified.h>
#include <freertos/queue.h>
#include "audio/mic_frame.h"
#include "face/face.h"
#include "net/ws_link.h"

#ifndef DOTS_MIC_VAD
#define DOTS_MIC_VAD 0
#endif

namespace dots {
class Microphone {
 public:
  void begin(WsLink& link, FaceController& face);
  bool start();
  void release();
  void abort();
  void update();
  bool available() const { return queue_ && M5.Mic.isEnabled(); }
  bool busy() const { return active_; }
 private:
  enum class End { None, Release, Timeout, Vad };
  WsLink* link_ = nullptr;
  FaceController* face_ = nullptr;
  QueueHandle_t queue_ = nullptr;
  bool active_ = false;
  uint16_t seq_ = 0;
  uint32_t startedAt_ = 0;
  int16_t buffers_[2][audio::kMicSamples] = {};
  audio::MicCadence cadence_;
  std::atomic<End> end_{End::None};
  std::atomic<bool> aborted_{false};
  std::atomic<bool> captureDone_{true};
  std::atomic<bool> txDone_{true};
#if DOTS_MIC_VAD
  bool heardVoice_ = false;
  size_t silentFrames_ = 0;
#endif
  void stop(End reason);
  static void captured(void* argument, void* data, size_t length);
  static void captureTask(void* argument);
  static void sendTask(void* argument);
};
}
