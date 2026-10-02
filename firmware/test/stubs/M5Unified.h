#pragma once
#include <cstddef>
#include <cstdint>
struct TestSpeaker {
  size_t slots = 0;
  size_t queuedSamples = 0;
  bool stopped = false;
  void setVolume(unsigned) {}
  void stop(unsigned) { stopped = true; }
  size_t isPlaying(unsigned channel) { return channel == 0 ? slots : 0; }
  bool playRaw(const int16_t*, size_t count, unsigned, bool, unsigned, unsigned, bool) {
    ++slots;
    queuedSamples += count;
    return true;
  }
  void tone(unsigned, unsigned, unsigned, bool) {}
};
struct TestM5 { TestSpeaker Speaker; };
inline TestM5 M5;
