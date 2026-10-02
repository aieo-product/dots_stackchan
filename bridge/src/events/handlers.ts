import { McpServer, ProtocolError, type ServerCapabilities, type ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";

import { EVENT_NAMES, argumentsSchema, eventDefinition, eventNameSchema, type EventName } from "./catalog.js";
import { validSigningSecret } from "./crypto.js";
import { EventDispatcher, type RecheckAccess } from "./dispatcher.js";

const metadata = z.record(z.string(), z.unknown()).optional();
const identityShape = {
  name: eventNameSchema, arguments: argumentsSchema.default({}),
  delivery: z.object({ mode: z.literal("webhook"), url: z.string().min(1).max(8_192) }).strict(),
  _meta: metadata,
};
const subscribeParams = z.object({
  ...identityShape,
  delivery: identityShape.delivery.extend({ secret: z.string().refine(validSigningSecret, "Invalid signing secret.") }),
  cursor: z.string().nullable().optional(),
  ttlMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
}).strict();
const unsubscribeParams = z.object(identityShape).strict();

export interface AuthorizationRequest {
  operation: "list" | "subscribe" | "unsubscribe";
  name?: EventName;
  arguments?: Record<string, never>;
}
export interface EventRegistrar { register(server: McpServer): void }
export interface EventHandlerDependencies {
  dispatcher: EventDispatcher;
  send: ReadonlySet<EventName>;
  // Implemented by the authentication layer; never derive ownership from request params.
  authorizePrincipal(context: ServerContext, request: AuthorizationRequest): Promise<string | null>;
  recheckAccess: RecheckAccess;
}

export function createEventRegistrar(dependencies: EventHandlerDependencies): EventRegistrar {
  async function authorize(context: ServerContext, request: AuthorizationRequest): Promise<string> {
    const principal = await dependencies.authorizePrincipal(context, request);
    if (!principal) throw new ProtocolError(-32001, "Event access denied.");
    return principal;
  }
  return {
    register(server): void {
      const capabilities: ServerCapabilities & { events: Record<string, never> } = { events: {} };
      server.server.registerCapabilities(capabilities);
      server.server.setRequestHandler("events/list", {
        params: z.object({ cursor: z.string().nullable().optional(), _meta: metadata }).strict(),
        result: z.object({ events: z.array(z.record(z.string(), z.unknown())) }),
      }, async (_, context) => {
        const principal = await authorize(context, { operation: "list" });
        const allowed = await Promise.all(EVENT_NAMES.map(async (name) =>
          dependencies.send.has(name) && await dependencies.recheckAccess(principal, name, {}) ? eventDefinition(name) : null));
        return { events: allowed.filter((event) => event !== null) };
      });
      server.server.setRequestHandler("events/subscribe", {
        params: subscribeParams,
        result: z.object({ id: z.string(), refreshBefore: z.string(), cursor: z.null(), truncated: z.literal(false) }),
      }, async (params, context) => {
        const principal = await authorize(context, { operation: "subscribe", name: params.name, arguments: params.arguments });
        if (!dependencies.send.has(params.name) || !await dependencies.recheckAccess(principal, params.name, params.arguments)) {
          throw new ProtocolError(-32001, "Event access denied.");
        }
        return dependencies.dispatcher.subscribe(principal, params);
      });
      server.server.setRequestHandler("events/unsubscribe", {
        params: unsubscribeParams, result: z.object({}).strict(),
      }, async (params, context) => {
        const principal = await authorize(context, { operation: "unsubscribe", name: params.name, arguments: params.arguments });
        return dependencies.dispatcher.unsubscribe(principal, params);
      });
    },
  };
}
