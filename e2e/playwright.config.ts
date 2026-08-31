import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests for the StreamCuts editor.
 *
 * This package sits outside `opencut-classic`'s bun workspace on purpose:
 * installing Playwright inside it would rewrite that workspace's lockfile,
 * which carries local-only overrides that must never be committed.
 *
 * The editor keeps projects in IndexedDB, and Playwright gives each run a fresh
 * browser profile, so every spec starts from an empty editor with no shared
 * state to clean up between runs.
 */
export default defineConfig({
	testDir: "./tests",
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	// The editor is heavy (wasm compositor + WebGPU); one worker keeps runs
	// deterministic and avoids several editors competing for the GPU.
	workers: 1,
	reporter: [["list"], ["html", { open: "never" }]],
	timeout: 90_000,
	expect: { timeout: 15_000 },
	use: {
		baseURL: process.env.STREAMCUTS_URL ?? "http://localhost:3000",
		trace: "on-first-retry",
		screenshot: "only-on-failure",
		video: "retain-on-failure",
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
	webServer: {
		command: "bun run dev",
		cwd: "../opencut-classic/apps/web",
		url: "http://localhost:3000",
		// Reuse the dev server if one is already up, so a local run doesn't
		// fight the editor you already have open.
		reuseExistingServer: !process.env.CI,
		timeout: 180_000,
	},
});
