#include <cstdlib>
#include <cassert>
#include <iostream>
#include <string>
#include <vector>
#include "protocol_frame.h"
#include "net/endpoint.h"
#include "servo/packet.h"
#include "audio/readiness.h"
#include "audio/pcm_ring.h"
#include "audio/mic_frame.h"
extern "C" {
#include "g2p.h"
}
int main(int argc, char** argv) {
  if (argc < 2) return 1;
  const std::string mode = argv[1];
  if (mode == "mic-pack") {
    int16_t pcm[dots::audio::kMicSamples] = {};
    pcm[0] = -32768; pcm[1] = -1; pcm[2] = 32767;
    dots::audio::MicFrame packed;
    packed.pack(0x1234, pcm);
    dots::protocol::BinaryFrame frame;
    assert(dots::protocol::decodeBinary(packed.bytes, sizeof(packed), frame));
    assert(frame.kind == 1 && frame.seq == 0x1234 && frame.length == 640);
    const uint8_t expected[] = {0, 128, 255, 255, 255, 127};
    for (size_t i = 0; i < sizeof(expected); ++i) assert(frame.payload[i] == expected[i]);
    for (size_t i = 6; i < frame.length; ++i) assert(frame.payload[i] == 0);
    packed.pack(65535, pcm);
    assert(packed.bytes[1] == 255 && packed.bytes[2] == 255);
    packed.pack(0, pcm);
    assert(packed.bytes[1] == 0 && packed.bytes[2] == 0);
    std::cout << sizeof(packed);
  } else if (mode == "mic-cadence") {
    dots::audio::MicCadence cadence;
    constexpr uint32_t start = UINT32_MAX - 100;
    for (size_t i = 0; i < 750; ++i) {
      assert(!cadence.timedOut(start + i * 20, start));
      assert(cadence.complete());
    }
    assert(cadence.frames() == 750 && !cadence.complete());
    assert(cadence.timedOut(start + 15000, start));
    dots::audio::MicCadence stalled;
    assert(!stalled.timedOut(start + 14999, start));
    assert(stalled.timedOut(start + 15000, start));
    std::cout << cadence.frames() * dots::audio::kMicSamples;
  } else if (mode == "binary") {
    std::vector<uint8_t> bytes;
    for (int i = 2; i < argc; ++i) bytes.push_back(std::atoi(argv[i]));
    dots::protocol::BinaryFrame frame;
    if (!dots::protocol::decodeBinary(bytes.data(), bytes.size(), frame)) std::cout << "invalid";
    else std::cout << unsigned(frame.kind) << ',' << frame.seq << ',' << frame.length;
  } else if (mode == "endpoint") {
    dots::net::Endpoint endpoint;
    if (!dots::net::parseEndpoint(argv[2], endpoint)) std::cout << "invalid";
    else std::cout << endpoint.host << ',' << endpoint.port << ',' << endpoint.path << ',' << endpoint.tls;
  } else if (mode == "servo") {
    const auto packet = dots::servo::positionPacket(1,
        dots::servo::position(std::stof(argv[2]), 460), 250);
    for (const auto value : packet) std::cout << unsigned(value) << ',';
  } else if (mode == "ready") {
    std::cout << dots::audio::readyToPlay(std::atoi(argv[2]), std::atoi(argv[3]),
        22050, std::atoi(argv[4]), std::atoi(argv[5]));
  } else if (mode == "ring-wrap") {
    int16_t storage[5], output[5];
    dots::audio::PcmRing ring;
    ring.reset(storage, 5);
    const uint8_t first[] = {1, 0, 255, 255, 0, 128, 255, 127};
    const uint8_t second[] = {2, 0, 3, 0, 4, 0};
    assert(ring.push(first, sizeof(first)) && ring.size() == 4);
    assert(ring.pop(output, 3) == 3 && output[0] == 1 && output[1] == -1 && output[2] == -32768);
    assert(ring.push(second, sizeof(second)));
    assert(ring.pop(output, 5) == 4);
    assert(output[0] == 32767 && output[1] == 2 && output[2] == 3 && output[3] == 4);
    assert(ring.size() == 0 && ring.pop(output, 1) == 0);
    std::cout << "ok";
  } else if (mode == "ring-invalid") {
    int16_t storage[2], output[2];
    dots::audio::PcmRing ring;
    ring.reset(storage, 2);
    const uint8_t bytes[] = {1, 0, 2, 0};
    assert(!ring.push(nullptr, 2) && !ring.push(bytes, 3) && ring.size() == 0);
    assert(ring.push(bytes, 4) && !ring.push(bytes, 2) && ring.size() == 2);
    assert(ring.pop(output, 2) == 2 && output[0] == 1 && output[1] == 2);
    ring.reset();
    assert(!ring.push(bytes, 2));
    std::cout << "ok";
  } else if (mode == "g2p") {
    int32_t ids[300], count = 0;
    saan_g2p_info info;
    const auto status = saan_g2p(argv[2], std::string(argv[2]).size(), ids, 300, &count, &info);
    std::cout << status << ',' << count;
  } else return 1;
}
