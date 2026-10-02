#pragma once

#include <Arduino.h>
#include <functional>
#include <vector>

#include "face/face.h"
#include "protocol.h"
#include "audio/pcm_ring.h"

namespace dots {

class AudioPlayer {
 public:
  using DoneHandler = std::function<void(uint16_t, bool)>;

  void begin(FaceController& face, DoneHandler doneHandler);
  bool startPcm(const protocol::Command& command);
  bool appendPcm(const protocol::BinaryFrame& frame);
  bool endPcm(uint16_t seq);
  bool playGenerated(int16_t* samples, size_t sampleCount, uint32_t sampleRate,
                     uint16_t seq, std::function<void()> release,
                     std::function<size_t()> available = nullptr);
  void cancel(bool notify = true);
  void chime();
  void update();
  bool playing() const { return playing_; }
  bool busy() const { return receiving_ || playing_; }

 private:
  static constexpr size_t kChunkSamples = 1024;
  audio::PcmRing ring_;
  bool stream_ = false;
  bool ended_ = false;
  bool primed_ = false;
  bool receivedSamples_ = false;
  size_t nextChunk_ = 0;
  size_t queuedChunks_ = 0;
  size_t queuedIds_[2] = {};
  float chunkLevels_[3] = {};
  int16_t* chunkBuffers_ = nullptr;
  FaceController* face_ = nullptr;
  DoneHandler doneHandler_;
  int16_t* samples_ = nullptr;
  size_t sampleCount_ = 0;
  size_t capacityBytes_ = 0;
  uint32_t sampleRate_ = 0;
  uint16_t seq_ = 0;
  uint32_t startedAt_ = 0;
  bool receiving_ = false;
  bool playing_ = false;
  bool ownsBuffer_ = false;
  bool submitted_ = false;
  size_t submittedSamples_ = 0;
  std::function<size_t()> available_;
  bool chiming_ = false;
  struct RetiredBuffer { int16_t* data; bool owned; std::function<void()> release; };
  std::vector<RetiredBuffer> retired_;
  std::function<void()> release_;

  bool playCurrent();
  void releaseBuffer();
  void updateStream();
  void finish(bool ok);
};

}  // namespace dots
