#include "audio/player.h"

#include <M5Unified.h>
#include <esp_heap_caps.h>

namespace dots {

void AudioPlayer::begin(FaceController& face, DoneHandler doneHandler) {
  face_ = &face;
  doneHandler_ = std::move(doneHandler);
  M5.Speaker.setVolume(160);
}

void AudioPlayer::releaseBuffer() {
  if (ownsBuffer_ && samples_) heap_caps_free(samples_);
  if (!ownsBuffer_ && release_) release_();
  samples_ = nullptr;
  sampleCount_ = 0;
  capacityBytes_ = 0;
  ownsBuffer_ = false;
  release_ = nullptr;
  available_ = nullptr;
  ring_.reset();
  chunkBuffers_ = nullptr;
  stream_ = false;
}

void AudioPlayer::cancel(bool notify) {
  const bool active = receiving_ || playing_;
  const bool hadSound = active || chiming_;
  const uint16_t cancelledSeq = seq_;
  if (playing_) M5.Speaker.stop(0);
  if (chiming_) M5.Speaker.stop(1);
  chiming_ = false;
  receiving_ = false;
  playing_ = false;
  if (face_ && hadSound) {
    face_->setMouth(0);
    face_->setState("idle");
  }
  if (submitted_) {
    // stop() is asynchronous: retain PCM until the speaker drops the channel.
    retired_.push_back({samples_, ownsBuffer_, std::move(release_)});
    // A moved-from std::function may retain its callable (including PCM owners).
    release_ = nullptr;
    available_ = nullptr;
    samples_ = nullptr;
    sampleCount_ = capacityBytes_ = 0;
    ownsBuffer_ = false;
    submitted_ = false;
    stream_ = false;
    ring_.reset();
    chunkBuffers_ = nullptr;
  } else releaseBuffer();
  if (active && notify && doneHandler_) doneHandler_(cancelledSeq, false);
}

bool AudioPlayer::startPcm(const protocol::Command& command) {
  cancel(true);
  if (command.sampleRate < 8000 || command.sampleRate > 48000 ||
      command.channels != 1 || command.bits != 16) {
    if (doneHandler_) doneHandler_(command.seq, false);
    return false;
  }
  seq_ = command.seq;
  sampleRate_ = command.sampleRate;
  const size_t ringSamples = sampleRate_ * 2;
  capacityBytes_ = (ringSamples + 3 * kChunkSamples) * sizeof(int16_t);
  samples_ = static_cast<int16_t*>(heap_caps_malloc(
      capacityBytes_, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (!samples_) {
    capacityBytes_ = 0;
    if (doneHandler_) doneHandler_(seq_, false);
    return false;
  }
  ring_.reset(samples_, ringSamples);
  chunkBuffers_ = samples_ + ringSamples;
  stream_ = true;
  ended_ = primed_ = receivedSamples_ = false;
  nextChunk_ = queuedChunks_ = 0;
  submitted_ = false;
  receiving_ = true;
  ownsBuffer_ = true;
  if (face_) face_->setState("thinking");
  return true;
}

bool AudioPlayer::appendPcm(const protocol::BinaryFrame& frame) {
  if (!receiving_ || !stream_ || frame.kind != 0x02 || frame.seq != seq_ ||
      frame.length == 0 || frame.length + 3 > protocol::kMaxBinaryFrameBytes ||
      frame.length % sizeof(int16_t) != 0) return false;
  if (!ring_.push(frame.payload, frame.length)) {
    // No overwritten or silently dropped audio on overflow.
    cancel(true);
    return false;
  }
  receivedSamples_ = true;
  return true;
}

bool AudioPlayer::playCurrent() {
  if (!samples_ || !sampleCount_ || !sampleRate_) return false;
  receiving_ = false;
  playing_ = true;
  submittedSamples_ = 0;
  submitted_ = false;  // update() submits after the old channel has drained.
  if (face_) face_->setState("speaking");
  return true;
}

bool AudioPlayer::endPcm(uint16_t seq) {
  if (!receiving_ || !stream_ || seq != seq_) return false;
  receiving_ = false;
  ended_ = true;
  // Short utterances must play even below the initial jitter threshold.
  playing_ = true;
  return true;
}

void AudioPlayer::finish(bool ok) {
  const uint16_t finishedSeq = seq_;
  receiving_ = playing_ = submitted_ = false;
  if (face_) {
    face_->setMouth(0);
    face_->setState("idle");
  }
  releaseBuffer();
  if (doneHandler_) doneHandler_(finishedSeq, ok);
}

void AudioPlayer::updateStream() {
  const size_t slots = M5.Speaker.isPlaying(0);
  if (queuedChunks_ && !slots && !ended_) primed_ = false;
  // The oldest queued request is currently playing. Three buffers in rotation
  // protect the recently released buffer too (the speaker task is asynchronous).
  while (queuedChunks_ > slots) {
    queuedIds_[0] = queuedIds_[1];
    --queuedChunks_;
  }
  if (ended_ && !ring_.size() && slots == 0) {
    finish(receivedSamples_);
    return;
  }
  if (slots == 0 && !ring_.size()) {
    primed_ = false;  // underrun: silence, then re-prime and resume
    if (face_) face_->setMouth(0);
    return;
  }
  const size_t threshold = sampleRate_ * 150 / 1000;
  if (!primed_ && (ring_.size() >= threshold || ended_)) {
    primed_ = true;
    playing_ = true;
    if (face_) face_->setState("speaking");
  }
  if (!primed_) return;
  if (ring_.size() && slots < 2) {
    int16_t* chunk = chunkBuffers_ + nextChunk_ * kChunkSamples;
    const size_t count = ring_.pop(chunk, kChunkSamples);
    int peak = 0;
    for (size_t i = 0; i < count; ++i) peak = max(peak, abs(static_cast<int>(chunk[i])));
    chunkLevels_[nextChunk_] = constrain(peak / 12000.0f, 0.0f, 1.0f);
    if (!M5.Speaker.playRaw(chunk, count, sampleRate_, false, 1, 0, false)) {
      cancel(true);
      return;
    }
    submitted_ = true;
    queuedIds_[queuedChunks_++] = nextChunk_;
    nextChunk_ = (nextChunk_ + 1) % 3;
  }
  if (face_) face_->setMouth(queuedChunks_ ? chunkLevels_[queuedIds_[0]] : 0);
}

bool AudioPlayer::playGenerated(int16_t* samples, size_t sampleCount,
                                uint32_t sampleRate, uint16_t seq,
                                std::function<void()> release,
                                std::function<size_t()> available) {
  cancel(true);
  samples_ = samples;
  sampleCount_ = sampleCount;
  sampleRate_ = sampleRate;
  seq_ = seq;
  ownsBuffer_ = false;
  release_ = std::move(release);
  available_ = std::move(available);
  if (playCurrent()) return true;
  releaseBuffer();
  if (doneHandler_) doneHandler_(seq, false);
  return false;
}

void AudioPlayer::chime() {
  chiming_ = true;
  if (face_) face_->setState("notifying");
  M5.Speaker.tone(880, 90, 1, true);
  M5.Speaker.tone(1175, 120, 1, false);
}

void AudioPlayer::update() {
  if (!M5.Speaker.isPlaying(0)) {
    for (auto& buffer : retired_) {
      if (buffer.owned) heap_caps_free(buffer.data);
      else if (buffer.release) buffer.release();
    }
    retired_.clear();
  }
  if (chiming_ && !M5.Speaker.isPlaying(1)) {
    chiming_ = false;
    if (!playing_ && face_) face_->setState("idle");
  }
  if (!retired_.empty()) return;
  if (stream_) { updateStream(); return; }
  if (!playing_) return;
  const size_t available = available_ ? min(sampleCount_, available_()) : sampleCount_;
  // Queue only synthesized samples: a slow pull can never race the speaker.
  if (submittedSamples_ < available && M5.Speaker.isPlaying(0) < 2) {
    const size_t count = min(static_cast<size_t>(1024), available - submittedSamples_);
    if (!M5.Speaker.playRaw(samples_ + submittedSamples_, count, sampleRate_, false, 1, 0, false)) {
      cancel(true);
      return;
    }
    if (!submitted_) startedAt_ = millis();
    submitted_ = true;
    submittedSamples_ += count;
  }
  if (submittedSamples_ == sampleCount_ && !M5.Speaker.isPlaying(0)) {
    const uint16_t finishedSeq = seq_;
    playing_ = false;
    submitted_ = false;
    if (face_) {
      face_->setMouth(0);
      face_->setState("idle");
    }
    releaseBuffer();
    if (doneHandler_) doneHandler_(finishedSeq, true);
    return;
  }
  const size_t position = min(
      available, static_cast<size_t>(static_cast<uint64_t>(millis() - startedAt_) * sampleRate_ / 1000));
  const size_t from = position > 64 ? position - 64 : 0;
  int peak = 0;
  for (size_t i = from; i < position; i += 4) peak = max(peak, abs(samples_[i]));
  if (face_) face_->setMouth(constrain(peak / 12000.0f, 0.0f, 1.0f));
}

}  // namespace dots
