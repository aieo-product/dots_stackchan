import type { StoreData } from "./store.js";

const BLOCK_MS = 15 * 60 * 1000;

export function blockedFor(data: StoreData, clientHash: string, now: number): number {
  return Math.max(0, ...["global", clientHash].map((key) => {
    const counter = data.lockouts[key];
    if (counter && counter.until !== 0 && counter.until <= now) Reflect.deleteProperty(data.lockouts, key);
    return (data.lockouts[key]?.until ?? 0) - now;
  }));
}

export function failedPasscode(data: StoreData, clientHash: string, now: number): boolean {
  for (const key of ["global", clientHash]) {
    const counter = data.lockouts[key] ?? { failures: 0, until: now + BLOCK_MS };
    counter.failures += 1;
    if (counter.failures >= 5) counter.until = now + BLOCK_MS;
    data.lockouts[key] = counter;
  }
  return data.lockouts.global.failures >= 5 || data.lockouts[clientHash].failures >= 5;
}

export function isBlocked(data: StoreData, clientHash: string, now: number): number {
  const remaining = blockedFor(data, clientHash, now);
  return ["global", clientHash].some((key) => (data.lockouts[key]?.failures ?? 0) >= 5) ? remaining : 0;
}
