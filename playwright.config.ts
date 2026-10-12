import { defineConfig } from "@playwright/test";
import { browserEvidenceDirectories } from "./scripts/evidence-paths.mjs";
const { browser: evidenceDir } = browserEvidenceDirectories();
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30000,
  expect: { timeout: 7000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["json", { outputFile: `${evidenceDir}/results.json` }]],
  use: {
    ignoreHTTPSErrors: true,
    screenshot: "only-on-failure",
    trace: "off",
    video: "off",
  },
  outputDir: `${evidenceDir}/artifacts`,
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        launchOptions: {
          ...(process.env.WEB_CONTROL_CHROMIUM_EXECUTABLE
            ? { executablePath: process.env.WEB_CONTROL_CHROMIUM_EXECUTABLE }
            : {}),
        },
      },
    },
    { name: "firefox", use: { browserName: "firefox" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
});
