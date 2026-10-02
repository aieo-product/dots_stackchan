#pragma once

#include <Arduino.h>
#include <functional>
#include <atomic>

#include "audio/player.h"

#ifndef DOTS_SANOTTS
#define DOTS_SANOTTS 0
#endif

namespace dots {

class SanoTtsVoice {
 public:
  using FailureHandler = std::function<void(uint16_t)>;

  void begin(AudioPlayer& player, FailureHandler failureHandler);
  using CacheHandler = std::function<void(int16_t*, size_t, uint32_t)>;
  // Transfers PSRAM ownership to the callback on the app loop; never plays audio.
  bool cache(const String& kana, CacheHandler handler);
  bool start(uint16_t seq, const String& kana, CacheHandler handler = nullptr);
  void cancel(bool notify = true);
  void update();
  bool available() const;
  bool busy() const {
#if DOTS_SANOTTS
    return active_ || !exited_ || pcm_;
#else
    return false;
#endif
  }

 private:
  AudioPlayer* player_ = nullptr;
  FailureHandler failureHandler_;
#if DOTS_SANOTTS
  CacheHandler cacheHandler_;
  bool cacheMode_ = false;
  String kana_;
  uint16_t seq_ = 0;
  int16_t* pcm_ = nullptr;
  std::atomic<size_t> total_{0};
  std::atomic<size_t> done_{0};
  std::atomic<bool> stop_{false};
  std::atomic<bool> failed_{false};
  std::atomic<bool> finished_{false};
  std::atomic<bool> exited_{true};
  bool active_ = false;
  bool startedPlayback_ = false;
  bool releaseRequested_ = false;
  uint32_t startedAt_ = 0;
  static void taskEntry(void* argument);
  void synthesize();
  void releaseWhenSafe();
#endif
};

}  // namespace dots
