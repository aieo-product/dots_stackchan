#pragma once
#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>

namespace dots {
// Sink owns a two-slot playback queue. stop() must release all sample pointers
// before returning. All player methods run on the transport/Arduino loop thread.
struct PcmSink {
  virtual ~PcmSink() = default;
  virtual size_t queued() const = 0;
  virtual bool play(const int16_t* samples, size_t count) = 0;
  virtual void stop() = 0;
};

class PcmPlayer {
 public:
  static constexpr size_t capacity = 8000;   // 500ms at 16kHz, fixed memory.
  static constexpr size_t prebuffer = 2400;  // Start/resume after 150ms.
  static constexpr size_t block = 320;       // 20ms lip-sync blocks.
  using Done = void (*)(uint16_t seq, bool ok);
  explicit PcmPlayer(PcmSink& sink, Done done) : sink_(sink), done_(done) {}

  void start(uint16_t seq, uint32_t now) {
    cancel(); seq_ = seq; active_ = true; last_input_ = now;
  }
  bool push(uint16_t seq, const uint8_t* bytes, size_t length, uint32_t now) {
    if (!active_ || seq != seq_ || ended_) return false;
    if (!length || length % 2 || length / 2 > capacity - size_) { finish(false); return false; }
    for (size_t i = 0; i < length; i += 2) {
      ring_[(head_ + size_) % capacity] = static_cast<int16_t>(bytes[i] | (static_cast<uint16_t>(bytes[i + 1]) << 8));
      ++size_;
    }
    has_audio_ = true; last_input_ = now; return true;
  }
  void end(uint16_t seq) {
    if (active_ && seq == seq_) {
      ended_ = true;
      if (!has_audio_) finish(false);
    }
  }
  void cancel() {
    if (active_) sink_.stop();
    active_ = running_ = ended_ = draining_ = has_audio_ = false;
    head_ = size_ = next_buffer_ = levels_size_ = 0; level_ = 0;
  }
  void tick(uint32_t now) {
    if (!active_) return;
    if (!ended_ && static_cast<uint32_t>(now - last_input_) > 30000) { finish(false); return; }
    size_t queued = sink_.queued();
    while (levels_size_ > queued) {
      levels_[0] = levels_[1]; --levels_size_;
    }
    if (!queued) {
      if (!draining_) { draining_ = true; silence_at_ = now; }
      // Allow the configured I2S DMA tail to leave the physical speaker.
      if (static_cast<uint32_t>(now - silence_at_) >= 50) level_ = 0;
      if (ended_ && !size_) {
        if (static_cast<uint32_t>(now - silence_at_) >= 50) finish(true);
        return;
      }
      running_ = false;  // Underrun: rebuffer, no busy wait or injected noise.
    }
    if (!running_) {
      if (size_ < prebuffer && !(ended_ && size_)) return;
      running_ = true;
    }
    while (queued < 2 && size_ && (size_ >= block || ended_)) {
      const size_t count = std::min(block, size_);
      auto* samples = playback_[next_buffer_];
      double sum = 0;
      for (size_t i = 0; i < count; ++i) {
        samples[i] = ring_[(head_ + i) % capacity];
        sum += static_cast<double>(samples[i]) * samples[i];
      }
      if (!sink_.play(samples, count)) { finish(false); return; }
      // Three buffers prevent overwriting either live M5Unified queue slot.
      next_buffer_ = (next_buffer_ + 1) % 3;
      head_ = (head_ + count) % capacity; size_ -= count;
      levels_[levels_size_++] = static_cast<float>(std::sqrt(sum / count) / 32768.0);
      ++queued; draining_ = false;
    }
    if (levels_size_) level_ = levels_[0];
  }
  float level() const { return level_; }
  bool active() const { return active_; }
  size_t buffered() const { return size_; }
 private:
  void finish(bool ok) { const auto seq = seq_; cancel(); if (done_) done_(seq, ok); }
  PcmSink& sink_;
  Done done_;
  int16_t ring_[capacity] = {};
  int16_t playback_[3][block] = {};
  float levels_[2] = {};
  float level_ = 0;
  size_t head_ = 0, size_ = 0, next_buffer_ = 0, levels_size_ = 0;
  uint16_t seq_ = 0;
  uint32_t last_input_ = 0, silence_at_ = 0;
  bool active_ = false, ended_ = false, running_ = false, draining_ = false, has_audio_ = false;
};
}  // namespace dots
