import { json, SCOPE } from "./protocol.js";

export function metadata(path: string, resource: string, issuer: string): Response | undefined {
  if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") {
    return json({ resource, authorization_servers: [issuer], bearer_methods_supported: ["header"], scopes_supported: [SCOPE] });
  }
  if (path === "/.well-known/oauth-authorization-server") {
    return json({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: [SCOPE],
      authorization_response_iss_parameter_supported: true,
    });
  }
  return undefined;
}

export function unauthorized(issuer: string, invalid: boolean): Response {
  return json({ error: "unauthorized" }, 401, {
    "www-authenticate": `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp", scope="${SCOPE}"${invalid ? ', error="invalid_token"' : ""}`,
  });
}
