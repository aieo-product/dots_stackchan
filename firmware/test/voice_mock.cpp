// Only the inference and task scheduler are simulated; voice/player lifetimes are real.
#include <functional>
#include <cstring>
#include <Arduino.h>
extern "C" {
#include "saan_model_blob.h"
#include "saanotts_stream.h"
alignas(16) const uint8_t saan_model_blob[16] = {};
const uint32_t saan_model_blob_size = 16;
}
std::function<void()> testPullHook;
bool testVoiceSuccess = false;
static unsigned pulls = 0;
extern "C" saan_status saan_weights_open(saan_weights*, const void*, size_t) { return SAAN_OK; }
extern "C" void saan_arena_init(saan_arena*, void*, size_t) {}
extern "C" saan_status saan_stream_init(saan_stream* stream, const saan_weights*, saan_arena*,
                                       const int32_t*, int32_t, float) {
  stream->n_frames = 16;
  pulls = 0;
  return SAAN_OK;
}
extern "C" saan_status saan_stream_pull(saan_stream*, float* output, int32_t* frames) {
  if (++pulls == 1) {
    std::memset(output, 0, sizeof(float) * 8 * SAAN_HOP);
    *frames = 8;
    return SAAN_OK;
  }
  if (testVoiceSuccess) {
    *frames = pulls == 2 ? 8 : 0;
    if (*frames) std::memset(output, 0, sizeof(float) * 8 * SAAN_HOP);
    return SAAN_OK;
  }
  if (testPullHook) testPullHook();
  return SAAN_ERR_ARENA;
}
