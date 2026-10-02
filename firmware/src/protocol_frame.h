#pragma once
#include <cstddef>
#include <cstdint>
namespace dots::protocol {
constexpr size_t kMaxBinaryFrameBytes = 4096;
struct BinaryFrame {
  uint8_t kind = 0;
  uint16_t seq = 0;
  const uint8_t* payload = nullptr;
  size_t length = 0;
};
inline bool decodeBinary(const uint8_t* data, size_t length, BinaryFrame& frame) {
  if (!data || length < 3 || length > kMaxBinaryFrameBytes) return false;
  frame.kind = data[0];
  frame.seq = static_cast<uint16_t>(data[1]) | (static_cast<uint16_t>(data[2]) << 8);
  frame.payload = data + 3;
  frame.length = length - 3;
  return frame.kind == 0x01 || frame.kind == 0x02;
}
}
