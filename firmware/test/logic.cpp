#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>
#include "protocol_frame.h"
#include "net/endpoint.h"
#include "servo/packet.h"
#include "audio/readiness.h"
extern "C" {
#include "g2p.h"
}
int main(int argc, char** argv) {
  if (argc < 2) return 1;
  const std::string mode = argv[1];
  if (mode == "binary") {
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
  } else if (mode == "g2p") {
    int32_t ids[300], count = 0;
    saan_g2p_info info;
    const auto status = saan_g2p(argv[2], std::string(argv[2]).size(), ids, 300, &count, &info);
    std::cout << status << ',' << count;
  } else return 1;
}
