import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";

export type CallbackReason = "invalid_url" | "non_public_address" | "dns_failed" | "redirect" | "timeout" | "challenge_failed" | "connection_failed";
export class CallbackError extends Error {
  constructor(readonly reason: CallbackReason) {
    super("Callback endpoint rejected.");
  }
}

export interface ResolvedAddress { address: string; family: number }
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;
export interface CallbackResponse { status: number; body: string }
export type WebhookPost = (url: string, body: string, headers: Record<string, string>) => Promise<CallbackResponse>;

export function isPublicAddress(address: string): boolean {
  if (!isIP(address) || address.includes("%")) return false;
  const parsed = ipaddr.parse(address);
  if (parsed.range() !== "unicast") return false;
  // IPv6 destinations must be global unicast, not unallocated address space.
  return parsed.kind() === "ipv4" || (parsed.toByteArray()[0] & 0xe0) === 0x20;
}

export async function validateDestination(
  value: string,
  resolve: Resolver = (hostname) => lookup(hostname, { all: true, verbatim: true }),
): Promise<{ url: URL; addresses: ResolvedAddress[] }> {
  let url: URL;
  try { url = new URL(value); } catch { throw new CallbackError("invalid_url"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || !url.hostname) {
    throw new CallbackError("invalid_url");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: ResolvedAddress[];
  try {
    addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await resolve(hostname);
  } catch { throw new CallbackError("dns_failed"); }
  if (!addresses.length || addresses.some(({ address, family }) => !isPublicAddress(address) || isIP(address) !== family)) {
    throw new CallbackError("non_public_address");
  }
  return { url, addresses };
}

// A new connection pins DNS to the inspected address. Node retains the URL hostname
// for SNI, certificate verification and Host; no pooling or redirect following.
export function createWebhookPost(resolve?: Resolver): WebhookPost {
  return async (value, body, headers) => {
    const signal = AbortSignal.timeout(10_000);
    let abort: (() => void) | undefined;
    try {
      const destination = await Promise.race([
        validateDestination(value, resolve),
        new Promise<never>((_, reject) => {
          abort = () => reject(new CallbackError("timeout"));
          signal.addEventListener("abort", abort, { once: true });
        }),
      ]);
      const address = destination.addresses[0];
      return await new Promise<CallbackResponse>((resolveResponse, reject) => {
        const req = request(destination.url, {
          method: "POST", agent: false, ...{ autoSelectFamily: false }, signal, headers,
          lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
        }, (response) => {
          const status = response.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            response.destroy();
            reject(new CallbackError("redirect"));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 16 * 1024) response.destroy(new CallbackError("challenge_failed"));
            else chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("end", () => resolveResponse({ status, body: Buffer.concat(chunks).toString("utf8") }));
        });
        req.on("error", (error) => reject(error instanceof CallbackError ? error :
          new CallbackError(signal.aborted ? "timeout" : "connection_failed")));
        req.end(body);
      });
    } finally {
      if (abort) signal.removeEventListener("abort", abort);
    }
  };
}
