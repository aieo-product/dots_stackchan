#if DOTS_SANOTTS
#ifndef SAAN_BLOB_PATH
#error "SAAN_BLOB_PATH is required when DOTS_SANOTTS=1"
#endif
    .section .rodata.saan_model, "a"
    .balign 16
    .global saan_model_blob
    .type saan_model_blob, @object
saan_model_blob:
    .incbin SAAN_BLOB_PATH
saan_model_blob_end:
    .size saan_model_blob, saan_model_blob_end - saan_model_blob

    .balign 4
    .global saan_model_blob_size
    .type saan_model_blob_size, @object
saan_model_blob_size:
    .word saan_model_blob_end - saan_model_blob
    .size saan_model_blob_size, 4
#endif
