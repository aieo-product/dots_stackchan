#pragma once
// Host-only adapter; the device uses the ESP32 mbedTLS implementation.
#include <openssl/hmac.h>
#include <string>
enum { MBEDTLS_MD_SHA256 };
struct mbedtls_md_info_t {};
struct mbedtls_md_context_t { std::string key, message; };
inline void mbedtls_md_init(mbedtls_md_context_t*) {}
inline const mbedtls_md_info_t* mbedtls_md_info_from_type(int) { static mbedtls_md_info_t info; return &info; }
inline int mbedtls_md_setup(mbedtls_md_context_t*, const mbedtls_md_info_t*, int) { return 0; }
inline int mbedtls_md_hmac_starts(mbedtls_md_context_t* context, const uint8_t* key, size_t size) {
  context->key.assign(reinterpret_cast<const char*>(key), size); return 0;
}
inline int mbedtls_md_hmac_update(mbedtls_md_context_t* context, const uint8_t* message, size_t size) {
  context->message.assign(reinterpret_cast<const char*>(message), size); return 0;
}
inline int mbedtls_md_hmac_finish(mbedtls_md_context_t* context, uint8_t* digest) {
  unsigned size = 32;
  HMAC(EVP_sha256(), context->key.data(), context->key.size(),
       reinterpret_cast<const uint8_t*>(context->message.data()), context->message.size(), digest, &size);
  return 0;
}
inline void mbedtls_md_free(mbedtls_md_context_t*) {}
