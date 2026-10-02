#pragma once
#include <cstddef>
#include <cstdint>
#include <vector>
#include <deque>
#include <cassert>
struct TestSpeaker {
  size_t slots = 0;
  size_t queuedSamples = 0;
  bool stopped = false;
  bool running = true;
  bool chime = false;
  struct Request { const int16_t* pointer; std::vector<int16_t> snapshot; };
  std::vector<Request> requests;
  void setVolume(unsigned) {}
  void stop() { stopped = true; chime = false; }
  void stop(unsigned channel) { stopped = true; if (channel == 1) chime = false; }
  bool begin() { running = true; return true; }
  void end() { running = false; slots = 0; chime = false; }
  size_t isPlaying(unsigned channel) { return channel == 0 ? slots : chime; }
  bool playRaw(const int16_t* data, size_t count, unsigned, bool, unsigned, unsigned, bool) {
    requests.push_back({data, std::vector<int16_t>(data, data + count)});
    ++slots;
    queuedSamples += count;
    return true;
  }
  void tone(unsigned, unsigned, unsigned, bool) { chime = true; }
};
struct TestMic {
  struct Config { unsigned sample_rate = 16000; };
  Config settings;
  bool running = false;
  bool failBegin = false;
  bool failRecord = false;
  void* argument = nullptr;
  void (*callback)(void*, void*, size_t) = nullptr;
  std::deque<int16_t*> requests;
  Config config() { return settings; }
  void config(Config value) { settings = value; }
  bool isEnabled() { return true; }
  bool begin() { running = !failBegin; return running; }
  void end() { running = false; requests.clear(); }
  void setBufferReleaseCallback(void* arg, decltype(callback) value) { argument = arg; callback = value; }
  bool record(int16_t* data, size_t size, unsigned rate, bool stereo) {
    assert(running && size == 320 && rate == 16000 && !stereo);
    if (failRecord) return false;
    requests.push_back(data); return true;
  }
  void complete(int16_t value = 1234) {
    assert(running && !requests.empty());
    auto* data = requests.front(); requests.pop_front();
    std::fill(data, data + 320, value);
    callback(argument, data, 320);
  }
};
struct TestButton {
  bool pressed = false, edge = false, hold = false;
  bool isPressed() { return pressed; }
  bool wasPressed() { return edge; }
  bool wasHold() { return hold; }
};
struct TestTouch {
  struct Detail { bool pressed; bool isPressed() const { return pressed; } };
  std::vector<Detail> details;
  size_t getCount() { return details.size(); }
  Detail getDetail(size_t i) { return details[i]; }
};
struct TestM5 {
  TestSpeaker Speaker; TestMic Mic;
  TestButton BtnA, BtnB, BtnC;
  TestTouch Touch;
};
inline TestM5 M5;
