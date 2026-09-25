// @ts-check
const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
  },
  webServer: {
    command: "npx http-server -p 4173 -c-1 .",
    port: 4173,
    reuseExistingServer: !process.env.CI,
  },
});
