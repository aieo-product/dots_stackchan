#include <M5Unified.h>

void setup() {
  auto config = M5.config();
  M5.begin(config);
  M5.Display.setTextDatum(middle_center);
  M5.Display.drawString("dots_stackchan", M5.Display.width() / 2, M5.Display.height() / 2);
}

void loop() {
  M5.update();
  delay(10);
}
