#include "audio/sanotts_voice.h"
#include "audio/readiness.h"

#include <M5Unified.h>
#include <esp_heap_caps.h>
#include <math.h>

#if DOTS_SANOTTS
extern "C" {
#include "g2p.h"
#include "saan_model_blob.h"
#include "saanotts.h"
#include "saanotts_stream.h"
}
#endif

namespace dots {

#if DOTS_SANOTTS
namespace {
constexpr size_t kArenaBytes = 176 * 1024;
constexpr int32_t kMaxIds = 300;
constexpr float kGain = 3.0f;
saan_weights weights;
bool weightsOk = false;

float softClip(float value) {
  constexpr float knee = 0.85f;
  const float amplitude = fabsf(value);
  if (amplitude <= knee) return value;
  const float clipped = knee + (1.0f - knee) *
                                   tanhf((amplitude - knee) / (1.0f - knee));
  return value < 0 ? -clipped : clipped;
}

int utf8Length(uint8_t lead) {
  return lead < 0x80 ? 1 : (lead >> 5) == 6 ? 2 : (lead >> 4) == 14 ? 3 : 4;
}

bool convertKana(String text, int32_t* ids, int32_t capacity, int32_t& count) {
  for (int attempt = 0; attempt < 64 && !text.isEmpty(); ++attempt) {
    saan_g2p_info info;
    const saan_g2p_status status =
        saan_g2p(text.c_str(), text.length(), ids, capacity, &count, &info);
    if (status == SAAN_G2P_OK) return true;
    if (status != SAAN_G2P_ERR_UNKNOWN || info.err_byte < 0 ||
        info.err_byte >= static_cast<int32_t>(text.length())) {
      return false;
    }
    text.remove(info.err_byte,
                utf8Length(static_cast<uint8_t>(text[info.err_byte])));
  }
  return false;
}
}  // namespace
#endif

void SanoTtsVoice::begin(AudioPlayer& player, FailureHandler failureHandler) {
  player_ = &player;
  failureHandler_ = std::move(failureHandler);
#if DOTS_SANOTTS
  if ((reinterpret_cast<uintptr_t>(saan_model_blob) & 15U) != 0) return;
  const saan_status status =
      saan_weights_open(&weights, saan_model_blob, saan_model_blob_size);
  weightsOk = status == SAAN_OK;
  Serial.printf("[sanotts] weights %s (%u bytes)\n", weightsOk ? "ready" : "invalid",
                static_cast<unsigned>(saan_model_blob_size));
#endif
}

bool SanoTtsVoice::available() const {
#if DOTS_SANOTTS
  return weightsOk;
#else
  return false;
#endif
}

bool SanoTtsVoice::start(uint16_t seq, const String& kana, CacheHandler handler) {
#if DOTS_SANOTTS
  if (!weightsOk || kana.isEmpty() || !exited_ || !player_) return false;
  if (pcm_ || active_) return false;
  cacheHandler_ = std::move(handler);
  cacheMode_ = static_cast<bool>(cacheHandler_);
  active_ = true;
  kana_ = kana;
  seq_ = seq;
  total_ = 0;
  done_ = 0;
  stop_ = false;
  failed_ = false;
  finished_ = false;
  exited_ = false;
  startedPlayback_ = false;
  releaseRequested_ = false;
  startedAt_ = millis();
  TaskHandle_t task = nullptr;
  if (xTaskCreatePinnedToCore(taskEntry, "sanotts", 16384, this, 2, &task, 0) != pdPASS) {
    exited_ = true;
    active_ = false;
    cacheHandler_ = nullptr;
    return false;
  }
  return true;
#else
  (void)seq;
  (void)kana;
  (void)handler;
  return false;
#endif
}

bool SanoTtsVoice::cache(const String& kana, CacheHandler handler) {
#if DOTS_SANOTTS
  return start(0, kana, std::move(handler));
#else
  (void)kana; (void)handler;
  return false;
#endif
}

void SanoTtsVoice::cancel(bool notify) {
#if DOTS_SANOTTS
  if (cacheHandler_) { cacheHandler_ = nullptr; notify = false; }
  stop_ = true;
  if (notify && active_ && !startedPlayback_ && failureHandler_) failureHandler_(seq_);
  active_ = false;
  if (startedPlayback_ && player_) player_->cancel(notify);
  else releaseRequested_ = true;
#else
  (void)notify;
#endif
}

void SanoTtsVoice::update() {
#if DOTS_SANOTTS
  if (releaseRequested_) releaseWhenSafe();
  if (cacheHandler_) {
    if (!exited_ || (!finished_ && !failed_)) return;
    auto handler = std::move(cacheHandler_);
    cacheHandler_ = nullptr;
    int16_t* samples = failed_ ? nullptr : pcm_;
    const size_t count = failed_ ? 0 : total_.load();
    if (samples) pcm_ = nullptr;
    failed_ = false;
    releaseRequested_ = true;
    releaseWhenSafe();
    handler(samples, count, SAAN_SR);
    return;
  }
  if (failed_ && exited_) {
    failed_ = false;
    if (stop_) return;
    if (startedPlayback_) player_->cancel(true);
    else {
      if (active_ && failureHandler_) failureHandler_(seq_);
      releaseRequested_ = true;
    }
    active_ = false;
    releaseWhenSafe();
    return;
  }
  if (stop_ || startedPlayback_ || !active_) return;
  const size_t readySamples = done_.load();  // acquire the worker's PCM writes
  const size_t totalSamples = total_.load();
  if (!readySamples || !pcm_ || !totalSamples) return;
  if (!audio::readyToPlay(readySamples, totalSamples, SAAN_SR,
                          millis() - startedAt_, finished_.load())) return;
  startedPlayback_ = player_->playGenerated(
      pcm_, totalSamples, SAAN_SR, seq_, [this]() { releaseRequested_ = true; },
      [this]() { return done_.load(); });
  if (!startedPlayback_) {
    stop_ = true;
    active_ = false;
    releaseRequested_ = true;
  } else {
    Serial.printf("[sanotts] playback after %lu ms\n", millis() - startedAt_);
  }
#endif
}

#if DOTS_SANOTTS
void SanoTtsVoice::taskEntry(void* argument) {
  static_cast<SanoTtsVoice*>(argument)->synthesize();
}

void SanoTtsVoice::synthesize() {
  uint8_t* arena = static_cast<uint8_t*>(heap_caps_aligned_alloc(
      16, kArenaBytes, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
  if (!arena) {
    arena = static_cast<uint8_t*>(heap_caps_aligned_alloc(
        16, kArenaBytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  }
  int32_t* ids = static_cast<int32_t*>(
      heap_caps_malloc(sizeof(int32_t) * (kMaxIds + 8), MALLOC_CAP_SPIRAM));
  float* chunk = static_cast<float*>(heap_caps_malloc(
      sizeof(float) * SAAN_CHUNK * SAAN_HOP, MALLOC_CAP_SPIRAM));
  int32_t idCount = 0;
  bool ok = arena && ids && chunk && convertKana(kana_, ids, kMaxIds, idCount) &&
            idCount > 3;

  saan_stream stream;
  saan_arena allocator;
  if (ok) {
    saan_arena_init(&allocator, arena, kArenaBytes);
    ok = saan_stream_init(&stream, &weights, &allocator, ids, idCount, SAAN_S_V) ==
         SAAN_OK;
    if (ok) {
      total_ = static_cast<size_t>(stream.n_frames) * SAAN_HOP;
      ok = total_ <= (cacheMode_ ? 52428U : 2U * 1024U * 1024U);
      if (ok) pcm_ = static_cast<int16_t*>(heap_caps_calloc(
          total_, sizeof(int16_t), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
      ok = ok && pcm_ != nullptr;
    }
  }

  size_t position = 0;
  saan_status status = SAAN_OK;
  int32_t frames = 0;
  while (ok && !stop_ &&
         (status = saan_stream_pull(&stream, chunk, &frames)) == SAAN_OK &&
         frames > 0) {
    const size_t count = static_cast<size_t>(frames) * SAAN_HOP;
    if (position + count > total_) {
      ok = false;
      break;
    }
    for (size_t i = 0; i < count; ++i) {
      float value = softClip(chunk[i] * kGain) * 32767.0f;
      value = constrain(value, -32768.0f, 32767.0f);
      pcm_[position + i] = static_cast<int16_t>(lrintf(value));
    }
    position += count;
    done_ = position;
    vTaskDelay(1);
  }
  if (status != SAAN_OK || (!stop_ && position != total_)) ok = false;
  if (ok && !stop_) {
    done_ = total_.load();
    finished_ = true;
  } else if (!stop_) {
    failed_ = true;
  }
  if (ids) heap_caps_free(ids);
  if (chunk) heap_caps_free(chunk);
  if (arena) heap_caps_free(arena);
  exited_ = true;
  vTaskDelete(nullptr);
}

void SanoTtsVoice::releaseWhenSafe() {
  if (!releaseRequested_ || !exited_) return;
  if (pcm_) heap_caps_free(pcm_);
  pcm_ = nullptr;
  total_ = 0;
  done_ = 0;
  releaseRequested_ = false;
  startedPlayback_ = false;
  active_ = false;
}
#endif

}  // namespace dots
