#include "audio/speech_dispatcher.h"
#include <esp_heap_caps.h>

namespace dots {
void SpeechDispatcher::begin(AudioPlayer& player, SanoTtsVoice& voice,
                             FaceController& face, AudioPlayer::DoneHandler done) {
  player_ = &player; voice_ = &voice; face_ = &face; done_ = std::move(done);
}
void SpeechDispatcher::finished(uint16_t seq) {
  if (active_ && seq == seq_) active_ = false;
}
void SpeechDispatcher::fail(std::deque<Pending>::iterator entry, bool notify) {
  const auto seq = entry->command.seq;
  if (entry->pcm) heap_caps_free(entry->pcm);
  pending_.erase(entry);
  if (notify && done_) done_(seq, false);
}
void SpeechDispatcher::command(const protocol::Command& command) {
  using protocol::CommandType;
  if (command.type == CommandType::TtsCancel) { cancel(); return; }
  if (command.type == CommandType::TtsEnd) {
    if (active_ && pcmOwner_ && command.seq == seq_) player_->endPcm(seq_);
    else for (auto& entry : pending_) {
      if (entry.command.type == CommandType::TtsStart && entry.command.seq == command.seq) {
        entry.ended = true;
        break;
      }
    }
    return;
  }
  if (command.type != CommandType::TtsStart && command.type != CommandType::SpeakKana) return;
  bool duplicate = active_ && seq_ == command.seq;
  for (const auto& entry : pending_) duplicate |= entry.command.seq == command.seq;
  // Duplicate seqs cannot be distinguished by tts.done; ignore retransmissions.
  if (duplicate) return;
  if (pending_.size() >= 4) { if (done_) done_(command.seq, false); return; }
  Pending next;
  next.command = command;
  pending_.push_back(std::move(next));
  update();
}
void SpeechDispatcher::append(const protocol::BinaryFrame& frame) {
  if (frame.kind != 0x02 || !frame.length || frame.length % 2 ||
      frame.length + 3 > protocol::kMaxBinaryFrameBytes) return;
  if (active_ && pcmOwner_ && frame.seq == seq_) { player_->appendPcm(frame); return; }
  for (auto it = pending_.begin(); it != pending_.end(); ++it) {
    if (it->command.type != protocol::CommandType::TtsStart || it->command.seq != frame.seq) continue;
    if (it->ended) return;
    const size_t capacity = static_cast<size_t>(it->command.sampleRate) * 4;
    if (it->used + frame.length > capacity) { fail(it); return; }
    if (!it->pcm) it->pcm = static_cast<uint8_t*>(heap_caps_malloc(
        capacity, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    if (!it->pcm) { fail(it); return; }
    memcpy(it->pcm + it->used, frame.payload, frame.length);
    it->used += frame.length;
    return;
  }
}
void SpeechDispatcher::cancel(bool notify) {
  while (!pending_.empty()) fail(pending_.begin(), notify);
  voice_->cancel(notify);
  player_->cancel(notify);
  active_ = false;
}
void SpeechDispatcher::update() {
  if (paused_ || active_ || player_->busy() || voice_->busy() || pending_.empty()) return;
  Pending entry = std::move(pending_.front());
  pending_.pop_front();
  seq_ = entry.command.seq;
  pcmOwner_ = entry.command.type == protocol::CommandType::TtsStart;
  active_ = true;
  face_->setVoiceMode(pcmOwner_ ? "bridge" : "device");
  if (pcmOwner_) {
    if (player_->startPcm(entry.command)) {
      for (size_t offset = 0; offset < entry.used; offset += 4092) {
        protocol::BinaryFrame frame;
        frame.kind = 0x02;
        frame.seq = seq_;
        frame.payload = entry.pcm + offset;
        frame.length = min(size_t(4092), entry.used - offset);
        if (!player_->appendPcm(frame)) break;
      }
      if (entry.ended) player_->endPcm(seq_);
    } else active_ = false;
  } else if (!voice_->start(seq_, entry.command.text)) {
    active_ = false;
    if (done_) done_(seq_, false);
  } else {
    face_->setState("thinking");
    if (!entry.command.expression.isEmpty()) face_->setExpression(entry.command.expression);
  }
  if (entry.pcm) heap_caps_free(entry.pcm);
}
}
