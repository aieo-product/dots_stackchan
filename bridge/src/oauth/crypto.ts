import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export function randomSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function equalHash(left: string, right: string): boolean {
  return timingSafeEqual(Buffer.from(hash(left), "hex"), Buffer.from(hash(right), "hex"));
}

export function passcodeChecker(passcode: string): (candidate: string) => boolean {
  const salt = randomBytes(16);
  const expected = scryptSync(passcode, salt, 32);
  return (candidate) => timingSafeEqual(scryptSync(candidate, salt, 32), expected);
}

export function validPkce(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const actual = createHash("sha256").update(verifier).digest("base64url");
  return equalHash(actual, challenge);
}
