import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));

describe("Slack secret scan", () => {
  it("detects dummy user and app tokens with the repository scanner", () => {
    const fixture = mkdtempSync(path.join(root, ".slack-pii-test-"));
    // Isolate the scan from concurrent tests without changing any tracked file.
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: fixture });
      for (const relative of ["scripts", "scripts/test"]) {
        execFileSync("mkdir", ["-p", path.join(fixture, relative)]);
      }
      for (const file of ["scripts/check-pii.sh", "scripts/pii-patterns.txt", ".pii-allowlist"]) {
        writeFileSync(path.join(fixture, file), readFileSync(path.join(root, file)));
      }
      for (const prefix of ["xoxp", "xapp"]) {
        writeFileSync(path.join(fixture, "dummy.txt"), [prefix, "test-only-not-a-secret"].join("-"));
        let output = "";
        try {
          execFileSync("bash", ["scripts/check-pii.sh"], { cwd: fixture, stdio: "pipe" });
          throw new Error("Scanner accepted a dummy Slack token");
        } catch (error) {
          if (!(error instanceof Error) || !("status" in error) || error.status !== 1) throw error;
          if ("stdout" in error) output = String(error.stdout);
        }
        expect(output).toContain(prefix === "xapp" ? "<redacted:slack-app-token>" : "<redacted:slack-token>");
        expect(output).not.toContain("test-only-not-a-secret");
      }
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
