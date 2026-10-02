#pragma once
#include <deque>
#include "audio/player.h"
#include "audio/sanotts_voice.h"

namespace dots {
// All callbacks and update() run on the app loop; inference has a separate task.
class SpeechDispatcher {
 public:
  void begin(AudioPlayer& player, SanoTtsVoice& voice, FaceController& face,
             AudioPlayer::DoneHandler done);
  void command(const protocol::Command& command);
  void append(const protocol::BinaryFrame& frame);
  void finished(uint16_t seq);
  void cancel();
  void update();
 private:
  struct Pending {
    protocol::Command command;
    uint8_t* pcm = nullptr;
    size_t used = 0;
    bool ended = false;
  };
  std::deque<Pending> pending_;
  AudioPlayer* player_ = nullptr;
  SanoTtsVoice* voice_ = nullptr;
  FaceController* face_ = nullptr;
  AudioPlayer::DoneHandler done_;
  bool active_ = false;
  bool pcmOwner_ = false;
  uint16_t seq_ = 0;
  void fail(std::deque<Pending>::iterator entry);
};
}
