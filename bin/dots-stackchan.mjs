#!/usr/bin/env node
import process from "node:process";
import console from "node:console";

import { unlockOAuth } from "../dist/oauth/unlock.js";
import { revokeOAuth } from "../dist/oauth/revoke.js";

if (process.argv.length !== 3 || !["revoke", "unlock"].includes(process.argv[2])) {
  console.error("Usage: dots-stackchan revoke|unlock");
  process.exitCode = 2;
} else {
  try {
    if (process.argv[2] === "unlock") {
      await unlockOAuth();
      console.info("OAuth lockout cleared. Failure counts retained.");
    } else {
      await revokeOAuth();
      console.info("OAuth clients, codes and tokens revoked. Reauthorize before connecting.");
    }
  } catch {
    console.error("OAuth operation failed. Stop the bridge and check the private store permissions and transaction lock.");
    process.exitCode = 1;
  }
}
