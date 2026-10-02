import { type EventRegistrar, createEventRegistrar, type EventHandlerDependencies } from "./handlers.js";
import { EventDispatcher, type DispatcherDependencies } from "./dispatcher.js";
import { type EventsConfig, readEventsConfig } from "./config.js";
import { EventStore } from "./store.js";

export interface EventsDependencies extends Pick<DispatcherDependencies, "source" | "post" | "now" | "onError" | "recheckAccess"> {
  authorizePrincipal: EventHandlerDependencies["authorizePrincipal"];
}

// The composition root can wire this to authentication and DeviceHub without
// either module depending on this optional service.
export function createEvents(dependencies: EventsDependencies, config: EventsConfig = readEventsConfig()): {
  registrar?: EventRegistrar;
  dispatcher?: EventDispatcher;
  close(): Promise<void>;
} {
  if (!config.enabled) return { close: async () => {} };
  if (!config.secretKey) throw new Error("Events storage key is required.");
  const dispatcher = new EventDispatcher({ ...dependencies, send: config.send,
    store: new EventStore(config.storeDir, config.secretKey) });
  return {
    dispatcher,
    registrar: createEventRegistrar({ ...dependencies, send: config.send, dispatcher }),
    close: () => dispatcher.close(),
  };
}
