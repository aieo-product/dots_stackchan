#pragma once
#ifdef ESP32
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#endif
namespace dots {
// WebSocketsClient is shared by loop() and microphone TX. Callbacks may send.
class SocketLock {
 public:
#ifdef ESP32
  SocketLock() : mutex_(xSemaphoreCreateRecursiveMutex()) { configASSERT(mutex_); }
  void lock() { xSemaphoreTakeRecursive(mutex_, portMAX_DELAY); }
  void unlock() { xSemaphoreGiveRecursive(mutex_); }
 private:
  SemaphoreHandle_t mutex_;
#else
  void lock() {}
  void unlock() {}
#endif
};
class SocketGuard {
 public:
  explicit SocketGuard(SocketLock& lock) : lock_(lock) { lock_.lock(); }
  ~SocketGuard() { lock_.unlock(); }
 private:
  SocketLock& lock_;
};
}
