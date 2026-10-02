#pragma once
#include <array>
#include <cmath>
#include <cstdint>

namespace dots::servo {
inline uint16_t position(float degrees, uint16_t center) {
  const int raw = center + static_cast<int>(std::lround(degrees / 0.3125f));
  return static_cast<uint16_t>(raw < 0 ? 0 : raw > 1000 ? 1000 : raw);
}
inline std::array<uint8_t, 13> positionPacket(uint8_t id, uint16_t position, uint16_t timeMs) {
  // SCS0009 uses big endian register words (the WebSocket header is little endian).
  std::array<uint8_t, 13> packet{
      0xff, 0xff, id, 9, 3, 42,
      static_cast<uint8_t>(position >> 8), static_cast<uint8_t>(position),
      static_cast<uint8_t>(timeMs >> 8), static_cast<uint8_t>(timeMs), 0, 0, 0};
  unsigned sum = 0;
  for (size_t i = 2; i < packet.size() - 1; ++i) sum += packet[i];
  packet.back() = static_cast<uint8_t>(~sum);
  return packet;
}
}
