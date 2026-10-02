export class OAuthError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); }
}

export function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "pragma": "no-cache",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}

export function uniqueParams(params: URLSearchParams): URLSearchParams {
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (seen.has(key)) throw new OAuthError("invalid_request");
    seen.add(key);
  }
  return params;
}

export function required(params: URLSearchParams, key: string): string {
  const value = params.get(key);
  if (!value) throw new OAuthError("invalid_request");
  return value;
}

export async function boundedBody(request: Request): Promise<string> {
  if (Number(request.headers.get("content-length")) > 8192) throw new OAuthError("invalid_request", 413);
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 8192) {
        await reader.cancel();
        throw new OAuthError("invalid_request", 413);
      }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}

export async function form(request: Request): Promise<URLSearchParams> {
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/x-www-form-urlencoded") {
    throw new OAuthError("invalid_request", 415);
  }
  return uniqueParams(new URLSearchParams(await boundedBody(request)));
}

export function canonicalResource(value: string, resource: string): boolean {
  try {
    const url = new URL(value);
    return !url.hash && !url.username && !url.password && url.href === resource;
  } catch { return false; }
}

export const SCOPE = "stackchan";

export function validateScope(value: string | null): void {
  if (value !== null && value !== SCOPE) throw new OAuthError("invalid_scope");
}
