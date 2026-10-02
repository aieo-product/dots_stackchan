#!/usr/bin/env node
import process from "node:process";
import console from "node:console";

import { revokeOAuth } from "../dist/oauth/revoke.js";

if (process.argv.length !== 3 || process.argv[2] !== "revoke") {
  console.error("Usage: dots-stackchan revoke");
  process.exitCode = 2;
} else {
  try {
    revokeOAuth();
    console.info("OAuth clients, codes and tokens revoked. Reauthorize before connecting.");
  } catch {
    console.error("Revocation failed. Stop the bridge and check the private store permissions and transaction lock.");
    process.exitCode = 1;
  }
}
