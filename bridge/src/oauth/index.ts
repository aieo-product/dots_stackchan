import { beginAuthorization, finishAuthorization } from "./authorize.js";
import { DEFAULT_REDIRECT_ORIGINS, readOAuthConfig, validateOAuthConfig, type OAuthConfig } from "./config.js";
import { hash, passcodeChecker } from "./crypto.js";
import { metadata, unauthorized } from "./metadata.js";
import { json, OAuthError } from "./protocol.js";
import { register } from "./register.js";
import { OAuthStore } from "./store.js";
import { exchange, verifyAccess } from "./token.js";

export type HttpHandler = (request: Request) => Promise<Response>;
export interface AccessEvent {
  readonly route: "mcp" | "metadata" | "register" | "authorize" | "token" | "other";
  readonly method: "GET" | "POST" | "DELETE" | "OPTIONS" | "other";
  readonly status: number;
}
export interface OAuth {
  /** Exclusive public surface: MCP, discovery and OAuth only. */
  wrap(mcpHandler: HttpHandler): HttpHandler;
  principal(request: Request): string | null;
  hasAccess(principal: string): boolean;
}
export interface OAuthOptions {
  readonly now?: () => number;
  /** Receives only fixed labels and status; never request headers, query, body, IDs or IPs. */
  readonly log?: (event: AccessEvent) => void;
}

export function createOAuth(config: OAuthConfig = readOAuthConfig(), options: OAuthOptions = {}): OAuth {
  const validated = validateOAuthConfig(config);
  const resource = validated.publicUrl;
  const issuer = new URL(resource).origin;
  const store = new OAuthStore(validated.storeDir, resource);
  store.read();
  const origins = validated.allowedRedirectOrigins ?? DEFAULT_REDIRECT_ORIGINS;
  const checkPasscode = passcodeChecker(validated.passcode);
  const now = options.now ?? Date.now;
  const log = options.log ?? ((event: AccessEvent) => console.info(JSON.stringify(event)));

  return {
    principal(request): string | null {
      const authorization = request.headers.get("authorization");
      if (!authorization || !/^Bearer [A-Za-z0-9_-]{43}$/i.test(authorization)) return null;
      return store.accessPrincipal(hash(authorization.slice(7)), resource, now());
    },
    hasAccess(principal): boolean {
      try { return store.principalActive(principal, resource, now()); }
      catch { return false; }
    },
    wrap(mcpHandler): HttpHandler {
      return async (request) => {
        let route: AccessEvent["route"] = "other";
        let response: Response;
        try {
          const url = new URL(request.url);
          if (url.pathname === "/mcp") route = "mcp";
          else if (url.pathname.startsWith("/.well-known/")) route = "metadata";
          else if (url.pathname === "/oauth/register") route = "register";
          else if (url.pathname === "/oauth/authorize") route = "authorize";
          else if (url.pathname === "/oauth/token") route = "token";
          if (request.url.length > 8192 || url.searchParams.has("access_token")) throw new OAuthError("invalid_request");
          // Browser requests are accepted only from the configured public origin.
          const origin = request.headers.get("origin");
          if (origin !== null && origin !== issuer) throw new OAuthError("invalid_request", 403);
          const discovery = metadata(url.pathname, resource, issuer);
          if (discovery) response = request.method === "GET" ? discovery : json({ error: "method_not_allowed" }, 405, { allow: "GET" });
          else if (route === "mcp") {
            const authorization = request.headers.get("authorization");
            response = verifyAccess(store, authorization, resource, now())
              ? await mcpHandler(request) : unauthorized(issuer, authorization !== null);
          } else if (route === "register" && request.method === "POST") response = await register(request, store, now(), origins);
          else if (route === "authorize" && request.method === "GET") response = await beginAuthorization(request, store, resource, now(), origins);
          else if (route === "authorize" && request.method === "POST") response = await finishAuthorization(request, store, issuer, now(), checkPasscode, origins);
          else if (route === "token" && request.method === "POST") response = await exchange(request, store, resource, now());
          else if (["register", "authorize", "token"].includes(route)) {
            response = json({ error: "method_not_allowed" }, 405, { allow: route === "authorize" ? "GET, POST" : "POST" });
          } else response = json({ error: "not_found" }, 404);
        } catch (error) {
          response = error instanceof OAuthError ? json({ error: error.code }, error.status) : json({ error: "server_error" }, 500);
        }
        const headers = new Headers(response.headers);
        headers.set("strict-transport-security", "max-age=31536000");
        response = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
        try {
          log({ route, method: ["GET", "POST", "DELETE", "OPTIONS"].includes(request.method) ? request.method as AccessEvent["method"] : "other", status: response.status });
        } catch { /* A logging sink must not change an authorization outcome. */ }
        return response;
      };
    },
  };
}

export function wrapMcpHandler(oauth: OAuth, handler: HttpHandler): HttpHandler {
  return oauth.wrap(handler);
}
