#include "cli.h"
#include <sys/time.h>

namespace dots {
void SerialCli::execute() {
  const auto& config = store_->get();
  bool ok = false;
  if ((line_ == "credits:on" || line_ == "credits:off") && creditsHandler_) {
    creditsHandler_(line_ == "credits:on");
    Serial.println("credits updated");
    return;
  } else if (line_.startsWith("wifi:")) {
    const int split = line_.indexOf(':', 5);
    if (split > 5) ok = store_->addWifi(line_.substring(5, split), line_.substring(split + 1));
  } else if (line_ == "wifi-list") {
    Serial.printf("wifi profiles: %u (values hidden)\n", static_cast<unsigned>(config.wifiCount));
    return;
  } else if (line_ == "wifi-clear") ok = store_->clearWifi();
  else if (line_.startsWith("server:")) ok = store_->setServer(line_.substring(7));
  else if (line_.startsWith("psk:")) ok = store_->setPsk(line_.substring(4));
  else if (line_.startsWith("device:")) ok = store_->setDeviceId(line_.substring(7));
  else if (line_.startsWith("ntp:")) ok = store_->setNtp(line_.substring(4));
  else if (line_.startsWith("time:")) {
    const String value = line_.substring(5);
    bool digits = !value.isEmpty();
    for (size_t i = 0; i < value.length(); ++i) digits &= isdigit(value[i]);
    const long long seconds = strtoll(value.c_str(), nullptr, 10);
    if (digits && seconds >= 1577836800 && seconds <= 2147483647) {
      timeval now{static_cast<time_t>(seconds), 0};
      ok = settimeofday(&now, nullptr) == 0;
    }
  } else if (line_.startsWith("servo:")) {
    unsigned pan, tilt, tx, rx;
    char extra;
    if (sscanf(line_.c_str(), "servo:%u:%u:%u:%u%c", &pan, &tilt, &tx, &rx, &extra) == 4 &&
        pan > 0 && pan < 254 && tilt > 0 && tilt < 254 && pan != tilt &&
        tx < 49 && rx < 49 && tx != rx) {
      ok = store_->setServo(pan, tilt, tx, rx);
    }
  } else if (line_ == "status") {
    Serial.printf("wifi=%u server=%s psk=%s device=%s ntp=%s clock=%s\n",
                  static_cast<unsigned>(config.wifiCount), masked(config.server).c_str(),
                  masked(config.psk).c_str(), masked(config.deviceId).c_str(),
                  masked(config.ntp).c_str(), time(nullptr) >= 1577836800 ? "ready" : "unset");
    return;
  } else if (line_ == "reboot") { ESP.restart(); return; }
  Serial.println(ok ? "saved; reboot to apply (time applies immediately)" : "invalid command or save failed");
}

void SerialCli::update() {
  // Never echo input: serial commands carry credentials.
  for (unsigned count = 0; count < 128 && Serial.available(); ++count) {
    const char ch = Serial.read();
    if (ch == '\r') continue;
    if (ch == '\n') {
      if (!overflow_ && !line_.isEmpty()) execute();
      else if (overflow_) Serial.println("command too long");
      line_ = "";
      overflow_ = false;
    } else if (line_.length() < 512 && !overflow_) line_ += ch;
    else { line_ = ""; overflow_ = true; }
  }
}
}
