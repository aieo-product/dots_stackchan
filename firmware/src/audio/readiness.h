#pragma once
#include <cstddef>
namespace dots::audio {
inline bool readyToPlay(size_t done, size_t total, unsigned rate, unsigned elapsedMs, bool finished) {
  if (!done || !total || !rate) return false;
  if (finished || done >= total) return true;
  const double ratio = 1.15 * elapsedMs * rate / (1000.0 * done);
  return done >= ratio * total / (1.0 + ratio);
}
}
