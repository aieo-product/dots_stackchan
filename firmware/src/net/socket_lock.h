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
  bool tryLock() { return xSemaphoreTakeRecursive(mutex_, 0) == pdTRUE; }
  void unlock() { xSemaphoreGiveRecursive(mutex_); }
 private:
  SemaphoreHandle_t mutex_;
#else
  void lock() {}
  bool tryLock() { return true; }
  void unlock() {}
#endif
};
class SocketGuard {
 public:
  explicit SocketGuard(SocketLock& lock, bool nonblocking = false) : lock_(lock) {
    if (nonblocking) locked_ = lock_.tryLock();
    else { lock_.lock(); locked_ = true; }
  }
  ~SocketGuard() { if (locked_) lock_.unlock(); }
  bool locked() const { return locked_; }
 private:
  SocketLock& lock_;
  bool locked_ = false;
};
}
