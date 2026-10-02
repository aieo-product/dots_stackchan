import { defaultStoreDirectory } from "./config.js";
import { OAuthStore } from "./store.js";

/** Run while stopped. Existing clients and every outstanding grant are invalidated. */
export async function revokeOAuth(directory = process.env.OAUTH_STORE_DIR ?? defaultStoreDirectory()): Promise<void> {
  await new OAuthStore(directory).transaction((data) => {
    data.clients = [];
    data.pending = [];
    data.codes = [];
    data.access = [];
    data.refresh = [];
    // Keep lockouts: revoking must not bypass a passcode block.
  });
}
