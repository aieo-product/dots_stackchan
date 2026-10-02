import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e", workers: 1, reporter: "list",
  use: { browserName: "chromium", headless: true, trace: "off", screenshot: "off", video: "off" },
});
