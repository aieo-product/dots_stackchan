import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let temporary: string;
let executable: string;
beforeAll(() => {
  temporary = mkdtempSync(join(tmpdir(), "dots-firmware-"));
  executable = join(temporary, "logic");
  const object = join(temporary, "g2p.o");
  execFileSync("cc", ["-std=c99", "-c", "firmware/lib/sanotts/src/g2p.c", "-o", object]);
  execFileSync("c++", ["-std=c++17", "-Ifirmware/src", "-Ifirmware/lib/sanotts/src",
    "firmware/test/logic.cpp", object, "-o", executable]);
}, 30_000);
afterAll(() => { if (temporary) rmSync(temporary, { recursive: true, force: true }); });
const run = (...args: (string | number)[]): string =>
  execFileSync(executable, args.map(String), { encoding: "utf8" });

describe("firmware native logic", () => {
  it("packs 20 ms signed PCM16 microphone frames with little endian seq in 643 bytes", () => {
    expect(run("mic-pack")).toBe("643");
  });
  it("caps sample-clock capture at 750 frames / 240000 samples including clock wrap and stalls", () => {
    expect(run("mic-cadence")).toBe("240000");
  });
  it("preserves PCM16 sample order and signed values across ring wrap", () => {
    expect(run("ring-wrap")).toBe("ok");
  });
  it("rejects overflow and partial samples without changing buffered audio", () => {
    expect(run("ring-invalid")).toBe("ok");
  });
  it("decodes the protocol v1 little endian sequence", () => {
    expect(run("binary", 2, 0x34, 0x12, 0, 1)).toBe("2,4660,2");
    expect(run("binary", 1, 255, 255)).toBe("1,65535,0");
  });
  it("rejects truncated, unknown, and oversized binary frames", () => {
    expect(run("binary", 2, 0)).toBe("invalid");
    expect(run("binary", 3, 0, 0)).toBe("invalid");
    expect(run("binary", ...Array<number>(4097).fill(2))).toBe("invalid");
    expect(run("binary", 2, 0, 0, ...Array<number>(4093).fill(0))).toBe("2,0,4093");
  });
  it("uses the v1 device route and TLS port", () => {
    expect(run("endpoint", "wss://example.org")).toBe("example.org,443,/device,1");
    expect(run("endpoint", "ws://192.0.2.1:8790/device")).toBe("192.0.2.1,8790,/device,0");
  });
  it.each(["https://example.org", "ws://example.org:0", "ws://example.org:65536",
    "ws://example.org:bad", "ws://example.org:80oops", "ws://example.org/other",
    "ws://user@example.org/device", "ws://example.org\r\nX-Auth:bad/device"])(
    "rejects invalid endpoint %s", (url) => { expect(run("endpoint", url)).toBe("invalid"); },
  );
  it("writes big endian servo registers with a valid checksum", () => {
    const packet = run("servo", 0).split(",").filter(Boolean).map(Number);
    expect(packet.slice(0, 12)).toEqual([255, 255, 1, 9, 3, 42, 1, 204, 0, 250, 0, 0]);
    expect(packet.slice(2).reduce((sum, value) => sum + value, 0) & 255).toBe(255);
    expect(run("servo", 10000).split(",").slice(6, 8)).toEqual(["3", "232"]);
    expect(run("servo", -10000).split(",").slice(6, 8)).toEqual(["0", "0"]);
  });
  it("waits for measured synthesis progress and always accepts completion", () => {
    expect(run("ready", 0, 22050, 100, 0)).toBe("0");
    expect(run("ready", 2048, 22050, 500, 0)).toBe("0");
    expect(run("ready", 18000, 22050, 500, 0)).toBe("1");
    expect(run("ready", 22050, 22050, 5000, 1)).toBe("1");
  });
  it("converts kana using the vendored G2P and rejects unsupported text", () => {
    const [status, count] = run("g2p", "こんにちわ").split(",").map(Number);
    expect(status).toBe(0);
    expect(count).toBeGreaterThan(3);
    expect(run("g2p", "漢字").split(",")[0]).not.toBe("0");
  });
});
