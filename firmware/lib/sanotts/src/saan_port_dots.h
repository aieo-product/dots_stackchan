/* Placement attributes for the sanoTTS-jp core on Arduino-ESP32. */
#ifndef SAAN_PORT_DOTS_H
#define SAAN_PORT_DOTS_H
#ifndef __ASSEMBLER__
#include "esp_attr.h"
#define SAAN_HOT_DATA DRAM_ATTR
#define SAAN_HOT_CODE IRAM_ATTR
#endif
#endif
