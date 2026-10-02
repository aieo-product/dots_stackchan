#include "audio/mic.h"
#include "protocol.h"

namespace dots {
void Microphone::begin(WsLink& link, FaceController& face) {
  link_ = &link;
  face_ = &face;
  // 640 ms bounded backlog. A stalled network never blocks the capture task.
  queue_ = xQueueCreate(32, sizeof(audio::MicFrame));
  M5.Mic.end();
}

bool Microphone::start() {
  if (active_ || !available() || !link_->connected()) return false;
  M5.Speaker.stop();
  M5.Speaker.end(); // CoreS3 shares the codec/I2S port with the microphone.
  auto config = M5.Mic.config();
  config.sample_rate = audio::kMicSampleRate;
  M5.Mic.config(config);
  if (!M5.Mic.begin()) { M5.Speaker.begin(); return false; }
  xQueueReset(queue_);
  cadence_ = audio::MicCadence{};
  end_ = End::None;
  aborted_ = false;
  captureDone_ = txDone_ = false;
#if DOTS_MIC_VAD
  heardVoice_ = false;
  silentFrames_ = 0;
#endif
  ++seq_; // u16 wrap is part of protocol v1.
  if (!link_->send(protocol::micStart(seq_))) {
    M5.Mic.end(); M5.Speaker.begin(); return false;
  }
  active_ = true;
  startedAt_ = millis();
  face_->setState("listening");
  M5.Mic.setBufferReleaseCallback(this, captured);
  TaskHandle_t task = nullptr;
  if (xTaskCreatePinnedToCore(sendTask, "mic-tx", 6144, this, 2, &task, 0) != pdPASS) {
    M5.Mic.end();
    M5.Mic.setBufferReleaseCallback(nullptr, nullptr);
    link_->send(protocol::micEnd(seq_, "timeout"));
    captureDone_ = txDone_ = true;
    return true;
  }
  if (xTaskCreatePinnedToCore(captureTask, "mic-capture", 4096, this, 3, &task, 1) != pdPASS) {
    stop(End::Timeout);
    M5.Mic.end();
    M5.Mic.setBufferReleaseCallback(nullptr, nullptr);
    captureDone_ = true;
  }
  return true;
}

void Microphone::stop(End reason) {
  End expected = End::None;
  end_.compare_exchange_strong(expected, reason);
}
void Microphone::release() { if (active_) stop(End::Release); }
void Microphone::abort() { if (active_) { aborted_ = true; stop(End::Release); } }

void Microphone::captured(void* argument, void* data, size_t length) {
  auto& mic = *static_cast<Microphone*>(argument);
  if (mic.end_ != End::None) return;
  if (length != audio::kMicSamples || !mic.cadence_.complete()) {
    mic.stop(End::Timeout); return;
  }
  auto* pcm = static_cast<int16_t*>(data);
  audio::MicFrame frame;
  frame.pack(mic.seq_, pcm);
  if (xQueueSend(mic.queue_, &frame, 0) != pdPASS) {
    mic.stop(End::Timeout); return; // fail closed instead of dropping mid-utterance PCM
  }
#if DOTS_MIC_VAD
  int peak = 0;
  for (size_t i = 0; i < length; ++i) peak = max(peak, abs(static_cast<int>(pcm[i])));
  if (peak >= 1000) { mic.heardVoice_ = true; mic.silentFrames_ = 0; }
  else ++mic.silentFrames_;
  if (mic.heardVoice_ && mic.silentFrames_ >= 40) mic.stop(End::Vad);
#endif
  if (mic.cadence_.timedOut(millis(), mic.startedAt_)) mic.stop(End::Timeout);
  // Re-arm from the M5 capture task; the other slot is already queued. Its
  // sample clock gives continuous 320-sample / 20 ms frames without loop jitter.
  if (mic.end_ == End::None &&
      !M5.Mic.record(pcm, audio::kMicSamples, audio::kMicSampleRate, false)) {
    mic.stop(End::Timeout);
  }
}

void Microphone::captureTask(void* argument) {
  auto& mic = *static_cast<Microphone*>(argument);
  if (!M5.Mic.record(mic.buffers_[0], audio::kMicSamples, audio::kMicSampleRate, false) ||
      !M5.Mic.record(mic.buffers_[1], audio::kMicSamples, audio::kMicSampleRate, false)) {
    mic.stop(End::Timeout);
  }
  while (mic.end_ == End::None) {
    if (static_cast<uint32_t>(millis() - mic.startedAt_) >= 15000) mic.stop(End::Timeout);
    vTaskDelay(1);
  }
  // end() joins the M5 task before buffers/callback can be reused or speaker starts.
  M5.Mic.end();
  M5.Mic.setBufferReleaseCallback(nullptr, nullptr);
  mic.captureDone_ = true;
  vTaskDelete(nullptr);
}

void Microphone::sendTask(void* argument) {
  auto& mic = *static_cast<Microphone*>(argument);
  audio::MicFrame frame;
  for (;;) {
    if (xQueueReceive(mic.queue_, &frame, pdMS_TO_TICKS(10)) == pdPASS) {
      if (!mic.aborted_ && !mic.link_->sendBinary(frame.bytes, sizeof(frame), &mic.aborted_)) {
        mic.abort();
      }
    } else if (mic.captureDone_ && uxQueueMessagesWaiting(mic.queue_) == 0) break;
  }
  if (!mic.aborted_) {
    const char* reason = mic.end_ == End::Timeout ? "timeout" :
                         mic.end_ == End::Vad ? "vad" : "release";
    mic.link_->send(protocol::micEnd(mic.seq_, reason), &mic.aborted_);
  }
  mic.txDone_ = true;
  vTaskDelete(nullptr);
}

void Microphone::update() {
  if (!active_ || !captureDone_ || !txDone_) return;
  M5.Speaker.begin();
  active_ = false;
  face_->setState(aborted_ ? "idle" : "thinking");
}
}
