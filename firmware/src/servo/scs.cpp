#include "servo/scs.h"

#include <M5Unified.h>
#include "servo/packet.h"

namespace dots {
namespace {
constexpr uint32_t kBaud = 1000000;
constexpr uint16_t kPanCenter = 460;
constexpr uint16_t kTiltCenter = 620;
constexpr uint8_t kPowerAddress = 0x6f;
constexpr uint8_t kVersionRegister = 0x02;
constexpr uint8_t kModeRegister = 0x03;
constexpr uint8_t kOutputRegister = 0x05;
constexpr uint8_t kPullUpRegister = 0x09;
constexpr uint8_t kPullDownRegister = 0x0b;
constexpr uint8_t kPowerMask = 0x01;

bool enableK151Power() {
  constexpr uint32_t frequency = 100000;
  const uint8_t version = M5.In_I2C.readRegister8(kPowerAddress, kVersionRegister,
                                                  frequency);
  if (version == 0 || version == 0xff) return false;
  auto setBit = [](uint8_t reg, bool value) {
    constexpr uint32_t frequency = 100000;
    uint8_t current = M5.In_I2C.readRegister8(kPowerAddress, reg, frequency);
    current = value ? current | kPowerMask : current & ~kPowerMask;
    M5.In_I2C.writeRegister8(kPowerAddress, reg, current, frequency);
  };
  setBit(kModeRegister, true);
  setBit(kPullDownRegister, false);
  setBit(kPullUpRegister, true);
  setBit(kOutputRegister, true);
  return true;
}
}  // namespace

void ScsServo::begin(const DeviceConfig& config) {
  panId_ = config.panServoId;
  tiltId_ = config.tiltServoId;
  if (!panId_ || !tiltId_ || config.servoTxPin == config.servoRxPin) return;
  const bool powered = enableK151Power();
  delay(300);
  bus_.begin(kBaud, SERIAL_8N1, config.servoRxPin, config.servoTxPin);
  available_ = true;
  Serial.printf("[servo] ready (power %s)\n", powered ? "managed" : "unmanaged");
}

void ScsServo::writePosition(uint8_t id, uint16_t position, uint16_t timeMs) {
  const auto packet = servo::positionPacket(id, position, timeMs);
  bus_.write(packet.data(), packet.size());
  bus_.flush();
}

void ScsServo::look(float panDegrees, float tiltDegrees) {
  if (!available_) return;
  const float pan = constrain(panDegrees, -90.0f, 90.0f);
  const float tilt = constrain(tiltDegrees, -30.0f, 30.0f);
  writePosition(panId_, servo::position(pan, kPanCenter), 250);
  writePosition(tiltId_, servo::position(tilt + 45.0f, kTiltCenter), 250);
}

}  // namespace dots
