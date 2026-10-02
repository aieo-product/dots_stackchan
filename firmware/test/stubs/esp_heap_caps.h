#pragma once
#include <cstdlib>
#define MALLOC_CAP_SPIRAM 1
#define MALLOC_CAP_8BIT 2
#define MALLOC_CAP_INTERNAL 4
inline unsigned testFrees = 0;
inline void heap_caps_free(void* pointer) { ++testFrees; std::free(pointer); }
inline void* heap_caps_realloc(void* pointer, size_t bytes, unsigned) { return std::realloc(pointer, bytes); }
inline void* heap_caps_malloc(size_t bytes, unsigned) { return std::malloc(bytes); }
inline void* heap_caps_calloc(size_t count, size_t bytes, unsigned) { return std::calloc(count, bytes); }
inline void* heap_caps_aligned_alloc(size_t alignment, size_t bytes, unsigned) {
  void* pointer = nullptr;
  return posix_memalign(&pointer, alignment, bytes) == 0 ? pointer : nullptr;
}
