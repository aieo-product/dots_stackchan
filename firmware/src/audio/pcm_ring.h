#pragma once
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <algorithm>

namespace dots::audio {
// Storage is owned by the player in PSRAM; producer and consumer run in loop().
class PcmRing {
 public:
  void reset(int16_t* data = nullptr, size_t capacity = 0) {
    data_ = data; capacity_ = capacity; read_ = write_ = used_ = 0;
  }
  size_t size() const { return used_; }
  bool push(const uint8_t* bytes, size_t length) {
    if (!bytes || length % 2 || length / 2 > capacity_ - used_) return false;
    for (size_t i = 0; i < length; i += 2) {
      // Wire data is unaligned and little endian.
      data_[write_] = static_cast<int16_t>(bytes[i] | (static_cast<uint16_t>(bytes[i + 1]) << 8));
      write_ = (write_ + 1) % capacity_;
    }
    used_ += length / 2;
    return true;
  }
  size_t pop(int16_t* output, size_t count) {
    count = std::min(count, used_);
    for (size_t i = 0; i < count; ++i) {
      output[i] = data_[read_];
      read_ = (read_ + 1) % capacity_;
    }
    used_ -= count;
    return count;
  }
 private:
  int16_t* data_ = nullptr;
  size_t capacity_ = 0, read_ = 0, write_ = 0, used_ = 0;
};
}
