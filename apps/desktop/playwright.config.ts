import { defineConfig, devices } from "@playwright/test";

// GitHub's Ubuntu 24.04 image already ships Chrome. CI can use that browser
// without an additional browser/apt download; local runs keep bundled Chromium.
const browserChannel = process.env.SHELL_EX_TEST_BROWSER_CHANNEL;
if (browserChannel && browserChannel !== "chrome") {
  throw new Error("SHELL_EX_TEST_BROWSER_CHANNEL must be chrome or unset");
}

export default defineConfig({
  testDir: "./tests",
  timeout: 45000,
  expect: { timeout: 7000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    locale: "zh-CN",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: browserChannel || "chromium",
      use: {
        ...devices["Desktop Chrome"],
        channel: browserChannel,
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
  webServer: {
    command: "npm run build && npm run preview -- --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 180000,
  },
});
