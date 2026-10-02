#pragma once
#include <algorithm>
#include <cstdint>
#include <cstring>
#include <string>
#include <cstdio>
#include <utility>
#include <functional>
using std::min;
using std::max;
template<class T> T constrain(T value, T low, T high) { return min(high, max(low, value)); }
class String : public std::string {
 public:
  String() = default;
  String(const char* value) : std::string(value ? value : "") {}
  String(const std::string& value) : std::string(value) {}
  explicit String(unsigned long value) : std::string(std::to_string(value)) {}
  bool isEmpty() const { return empty(); }
  bool concat(const char* value) { append(value); return true; }
  void remove(size_t start, size_t length) { erase(start, length); }
  String& operator=(const char* value) { assign(value ? value : ""); return *this; }
};
inline uint32_t testMillis = 0;
inline uint32_t millis() { return testMillis; }
struct TestSerial {
  void println(const char*) {}
  template<class... Args> void printf(const char*, Args...) {}
};
inline TestSerial Serial;
using TaskHandle_t = void*;
constexpr int pdPASS = 1;
inline std::function<void()> testTask;
inline int xTaskCreatePinnedToCore(void (*entry)(void*), const char*, unsigned, void* value,
                                  unsigned, TaskHandle_t*, unsigned) {
  testTask = [=] { entry(value); };
  return pdPASS;
}
inline void vTaskDelay(unsigned ticks) { testMillis += ticks; }
inline void vTaskDelete(void*) {}
