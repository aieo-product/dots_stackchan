import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export function decodeKey(value: string, minBytes: number, maxBytes = minBytes): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("Invalid base64 key.");
  }
  const key = Buffer.from(value, "base64");
  if (key.length < minBytes || key.length > maxBytes || key.toString("base64") !== value) {
    throw new Error("Invalid key length or encoding.");
  }
  return key;
}

export function validSigningSecret(value: string): boolean {
  if (!value.startsWith("whsec_")) return false;
  try {
    decodeKey(value.slice(6), 24, 64);
    return true;
  } catch {
    return false;
  }
}

export function seal(value: string, key: Buffer, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

export function unseal(value: string, key: Buffer, context: string): string {
  const encrypted = Buffer.from(value, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, encrypted.subarray(0, 12));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(encrypted.subarray(12, 28));
  return Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]).toString("utf8");
}
