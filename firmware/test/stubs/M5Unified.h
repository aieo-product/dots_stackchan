#pragma once
#include <cstddef>
#include <cstdint>
#include <vector>
struct TestSpeaker {
  size_t slots = 0;
  size_t queuedSamples = 0;
  bool stopped = false;
  struct Request { const int16_t* pointer; std::vector<int16_t> snapshot; };
  std::vector<Request> requests;
  void setVolume(unsigned) {}
  void stop(unsigned) { stopped = true; }
  size_t isPlaying(unsigned channel) { return channel == 0 ? slots : 0; }
  bool playRaw(const int16_t* data, size_t count, unsigned, bool, unsigned, unsigned, bool) {
    requests.push_back({data, std::vector<int16_t>(data, data + count)});
    ++slots;
    queuedSamples += count;
    return true;
  }
  void tone(unsigned, unsigned, unsigned, bool) {}
};
struct TestM5 { TestSpeaker Speaker; };
inline TestM5 M5;
