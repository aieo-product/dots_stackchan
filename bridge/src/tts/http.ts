/** Deadlines cover headers AND streaming bodies. Always dispose after consumption. */
export function requestScope(timeoutMs: number, parent?: AbortSignal): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason);
  parent?.addEventListener('abort', abort, { once: true });
  if (parent?.aborted) abort();
  const timer = setTimeout(() => controller.abort(new Error('TTS HTTP request timed out')), timeoutMs);
  return { signal: controller.signal, dispose() { clearTimeout(timer); parent?.removeEventListener('abort', abort); } };
}

export function httpUrl(value: string, label: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${label} requires an HTTP URL`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(`${label} requires an HTTP URL without credentials`);
  return url;
}
