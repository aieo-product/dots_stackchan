#pragma once
#include <memory>
#include <vector>
#include "audio/sanotts_voice.h"

namespace dots {
class FillerCache {
 public:
  void begin(AudioPlayer& player, SanoTtsVoice& voice) { player_ = &player; voice_ = &voice; }
  void set(const std::vector<protocol::FillerPhrase>& phrases);
  void append(const protocol::BinaryFrame& frame);
  void update(bool idle);
  void ended(uint16_t seq);
  void wait(uint16_t seq);
  void cancel();
  void interruptSynthesis();
  bool finished() { if (!playing_) return false; playing_ = false; return true; }
  bool ready() const;
 private:
  struct Entry {
    protocol::FillerPhrase phrase;
    std::shared_ptr<int16_t> pcm;
    size_t count = 0, received = 0;
    uint32_t rate = 16000;
  };
  std::vector<Entry> entries_;
  AudioPlayer* player_ = nullptr;
  SanoTtsVoice* voice_ = nullptr;
  bool playing_ = false, waiting_ = false, synthesizing_ = false, failed_ = false;
  uint16_t seq_ = 0;
  unsigned waitCount_ = 0;
  size_t choice_ = 0;
  void play(bool wait);
};
}
