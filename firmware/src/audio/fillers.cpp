#include "audio/fillers.h"
#include <esp_heap_caps.h>

namespace dots {
namespace {
std::shared_ptr<int16_t> own(int16_t* data) {
  return std::shared_ptr<int16_t>(data, [](int16_t* value) { heap_caps_free(value); });
}
}
void FillerCache::interruptSynthesis() {
  if (synthesizing_) { voice_->cancel(false); synthesizing_ = false; }
}
void FillerCache::cancel() {
  waiting_ = false;
  if (playing_) { playing_ = false; player_->cancel(false); }
}
void FillerCache::set(const std::vector<protocol::FillerPhrase>& phrases) {
  cancel(); interruptSynthesis(); entries_.clear(); failed_ = false; choice_ = 0;
  if (phrases.size() > 5) return;
  for (const auto& phrase : phrases) {
    Entry entry; entry.phrase = phrase;
    if (phrase.samples) {
      entry.count = phrase.samples;
      if (entry.count > 52428) { failed_ = true; break; }
      auto* pcm = static_cast<int16_t*>(heap_caps_malloc(entry.count * 2, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
      if (!pcm) { failed_ = true; break; }
      entry.pcm = own(pcm);
    }
    entries_.push_back(std::move(entry));
  }
}
bool FillerCache::ready() const {
  if (failed_ || entries_.empty()) return false;
  for (const auto& entry : entries_) if (!entry.pcm || !entry.count || entry.received != entry.count * 2) return false;
  return true;
}
void FillerCache::append(const protocol::BinaryFrame& frame) {
  if (frame.kind != 0x03 || frame.seq >= entries_.size() || !frame.length || frame.length % 2) return;
  auto& entry = entries_[frame.seq];
  if (!entry.phrase.samples || !entry.pcm || entry.received == entry.count * 2) return;
  if (entry.received + frame.length > entry.count * 2) { failed_ = true; return; }
  memcpy(reinterpret_cast<uint8_t*>(entry.pcm.get()) + entry.received, frame.payload, frame.length);
  entry.received += frame.length;
}
void FillerCache::update(bool idle) {
  if (synthesizing_ && !voice_->busy()) synthesizing_ = false;
  if (!idle || synthesizing_ || failed_ || voice_->busy() || player_->busy()) return;
  for (size_t i = 0; i < entries_.size(); ++i) {
    auto& entry = entries_[i];
    if (entry.pcm || entry.phrase.kana.isEmpty()) continue;
    synthesizing_ = voice_->cache(entry.phrase.kana, [this, i](int16_t* samples, size_t count, uint32_t rate) {
      synthesizing_ = false;
      auto pcm = own(samples);
      if (!samples || !count || count > 52428) { failed_ = true; return; }
      auto& target = entries_[i];
      target.pcm = std::move(pcm); target.count = count; target.rate = rate; target.received = count * 2;
      Serial.printf("[fillers] cached %u samples\n", static_cast<unsigned>(count));
    });
    if (!synthesizing_) failed_ = true;
    return;
  }
}
void FillerCache::play(bool wait) {
  if (!ready() || player_->busy() || voice_->busy()) return;
  std::vector<size_t> candidates;
  for (size_t i = 0; i < entries_.size(); ++i) if (entries_[i].phrase.wait == wait) candidates.push_back(i);
  if (candidates.empty()) return;
  auto& entry = entries_[candidates[choice_++ % candidates.size()]];
  auto keep = entry.pcm; // Keep alive through asynchronous speaker stop and cache replacement.
  playing_ = true;
  if (!player_->playGenerated(entry.pcm.get(), entry.count, entry.rate, 0,
                             [keep]() {})) playing_ = false;
  else Serial.printf("[fillers] start t=%lu kind=%s\n", millis(), wait ? "wait" : "ack");
}
void FillerCache::ended(uint16_t seq) {
  seq_ = seq; waiting_ = true; waitCount_ = 0;
  play(false);
}
void FillerCache::wait(uint16_t seq) {
  if (!waiting_ || seq != seq_ || waitCount_ >= 2) return;
  ++waitCount_; play(true);
}
}
