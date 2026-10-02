#include "pcm-player.h"
#include <cassert>
#include <deque>
#include <iostream>
#include <vector>
struct FakeSink : dots::PcmSink {
  std::deque<std::pair<const int16_t*, size_t>> live;
  size_t plays = 0, stops = 0;
  bool fail = false;
  size_t queued() const override { return live.size(); }
  bool play(const int16_t* data, size_t count) override {
    if (fail) return false;
    live.push_back({data, count}); ++plays; return true;
  }
  void stop() override { live.clear(); ++stops; }
};
static std::vector<std::pair<uint16_t, bool>> completions;
static void done(uint16_t seq, bool ok) { completions.push_back({seq, ok}); }
static std::vector<uint8_t> pcm(size_t count, int16_t value = 10000) {
  std::vector<uint8_t> bytes(count * 2);
  for (size_t i = 0; i < count; ++i) { bytes[2*i] = value & 255; bytes[2*i+1] = (value >> 8) & 255; }
  return bytes;
}
int main() {
  FakeSink sink; dots::PcmPlayer player(sink, done);
  auto short_audio = pcm(2399);
  player.start(1, 0); assert(player.push(1, short_audio.data(), short_audio.size(), 0));
  player.tick(0); assert(sink.plays == 0);
  auto sample = pcm(1); player.push(1, sample.data(), sample.size(), 1); player.tick(1);
  assert(sink.plays == 2 && player.active() && player.level() > 0.3);
  // Sample storage stays valid while both M5 queue slots reference it.
  const auto* first = sink.live.front().first; const auto* second = sink.live.back().first;
  sink.live.pop_front(); player.tick(21);
  assert(sink.live.front().first == second && second[0] == 10000);
  assert(sink.live.back().first != first && sink.live.back().first != second);
  // Exhaust current buffered audio before tts.end, then rebuffer on underrun.
  for (uint32_t now = 41; now < 301; now += 20) { sink.live.clear(); player.tick(now); }
  assert(player.active() && sink.live.empty() && player.level() == 0);
  auto small = pcm(100); const auto before = sink.plays;
  player.push(1, small.data(), small.size(), 301); player.tick(301); assert(sink.plays == before);
  auto more = pcm(2400); player.push(1, more.data(), more.size(), 302); player.tick(302); assert(sink.plays == before + 2);
  player.end(99); assert(player.active()); // Stale messages cannot finish this stream.
  player.end(1);
  for (uint32_t now = 322; now < 702; now += 20) { sink.live.clear(); player.tick(now); }
  assert(!player.active() && completions.back() == std::make_pair(uint16_t(1), true));
  // Short last utterance starts on end; completion waits for queued audio + DMA.
  player.start(2, 800); player.push(2, small.data(), small.size(), 800); player.end(2); player.tick(800);
  assert(sink.live.size() == 1); player.tick(900); assert(player.active());
  sink.live.clear(); player.tick(901); player.tick(950); assert(player.active());
  player.tick(951); assert(!player.active());
  player.start(3, 1000); player.push(3, more.data(), more.size(), 1000); player.tick(1000);
  player.cancel(); assert(!player.active() && sink.live.empty() && player.level() == 0);
  assert(!player.push(3, small.data(), small.size(), 1001));
  // Overflow and incomplete samples fail explicitly, never drop PCM silently.
  player.start(4, 1100); auto huge = pcm(dots::PcmPlayer::capacity + 1);
  assert(!player.push(4, huge.data(), huge.size(), 1100)); assert(!completions.back().second);
  player.start(5, 1200); assert(!player.push(5, small.data(), 1, 1200));
  player.start(6, 1300); player.tick(31301); assert(!player.active());
  sink.fail = true; player.start(7, 32000); player.push(7, more.data(), more.size(), 32000); player.tick(32000);
  assert(!player.active() && !completions.back().second);
  sink.fail = false; player.start(8, 33000); player.end(8);
  assert(!player.active() && !completions.back().second);
  player.start(9, 34000); auto exact_blocks = pcm(2560);
  player.push(9, exact_blocks.data(), exact_blocks.size(), 34000);
  player.tick(34000);
  for (uint32_t now = 34020; now < 34300; now += 20) {
    if (!sink.live.empty()) sink.live.pop_front();
    player.tick(now);
  }
  player.end(9); player.tick(34300);
  assert(!player.active() && completions.back().second);
  std::cout << "PCM playback: prebuffer, streaming, buffer lifetime, underrun, drain, cancel, overflow, timeout passed\n";
}
