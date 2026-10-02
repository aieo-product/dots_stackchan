#pragma once
#include <cstring>
#include <deque>
#include <functional>
#include <memory>
#include <vector>
#include <Arduino.h>
struct TestQueue {
  size_t capacity;
  size_t itemSize;
  std::deque<std::vector<uint8_t>> entries;
};
using QueueHandle_t = TestQueue*;
inline std::vector<std::unique_ptr<TestQueue>> testQueues;
inline std::function<void(TestQueue*)> testQueueSent;
inline QueueHandle_t xQueueCreate(size_t count, size_t size) {
  testQueues.push_back(std::make_unique<TestQueue>(TestQueue{count, size, {}}));
  return testQueues.back().get();
}
inline int xQueueReset(QueueHandle_t queue) { queue->entries.clear(); return pdPASS; }
inline size_t uxQueueMessagesWaiting(QueueHandle_t queue) { return queue->entries.size(); }
inline int xQueueSend(QueueHandle_t queue, const void* data, unsigned) {
  if (queue->entries.size() >= queue->capacity) return 0;
  const auto* bytes = static_cast<const uint8_t*>(data);
  queue->entries.emplace_back(bytes, bytes + queue->itemSize);
  if (testQueueSent) testQueueSent(queue);
  return pdPASS;
}
inline int xQueueReceive(QueueHandle_t queue, void* data, unsigned) {
  if (queue->entries.empty()) return 0;
  std::memcpy(data, queue->entries.front().data(), queue->itemSize);
  queue->entries.pop_front();
  return pdPASS;
}
inline unsigned pdMS_TO_TICKS(unsigned ms) { return ms; }
