#include <M5Unified.h>
#include "app.h"

void setup() {
  auto config = M5.config();
  M5.begin(config);
  Serial.begin(115200);
  dots::begin();
}

void loop() {
  M5.update();
  dots::update();
  delay(2);
}
