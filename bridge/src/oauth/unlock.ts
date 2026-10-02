import { defaultStoreDirectory } from "./config.js";
import { OAuthStore } from "./store.js";

/** Local operator recovery only. Keep failure counts and all grants. No HTTP endpoint. */
export async function unlockOAuth(directory = process.env.OAUTH_STORE_DIR ?? defaultStoreDirectory()): Promise<void> {
  await new OAuthStore(directory).transaction((data) => {
    for (const counter of Object.values(data.lockouts)) counter.until = 0;
  });
}
