#pragma once
#include <cstddef>
#include <cstdint>
#include "protocol_frame.h"

namespace dots { namespace audio {
constexpr uint32_t kMicSampleRate = 16000;
constexpr uint32_t kMicFrameMs = 20;
constexpr size_t kMicSamples = kMicSampleRate * kMicFrameMs / 1000;
constexpr size_t kMicMaxFrames = 15000 / kMicFrameMs;
struct MicFrame {
  uint8_t bytes[3 + kMicSamples * 2] = {};
  void pack(uint16_t seq, const int16_t* pcm) {
    bytes[0] = 0x01;
    bytes[1] = seq & 255;
    bytes[2] = seq >> 8;
    for (size_t i = 0; i < kMicSamples; ++i) {
      bytes[3 + i * 2] = static_cast<uint16_t>(pcm[i]) & 255;
      bytes[4 + i * 2] = static_cast<uint16_t>(pcm[i]) >> 8;
    }
  }
};
static_assert(sizeof(MicFrame) <= protocol::kMaxBinaryFrameBytes, "mic frame limit");
// Audio samples, rather than loop delays, define the cadence. No catch-up frames.
class MicCadence {
 public:
  bool complete() { if (frames_ == kMicMaxFrames) return false; ++frames_; return true; }
  bool timedOut(uint32_t now, uint32_t start) const {
    return frames_ == kMicMaxFrames || static_cast<uint32_t>(now - start) >= 15000;
  }
  size_t frames() const { return frames_; }
 private:
  size_t frames_ = 0;
};
} }
