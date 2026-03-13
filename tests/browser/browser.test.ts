import { describe, it, expect } from "vitest"
import {
	launchBrowser,
	createContext,
	createPage,
	closeBrowser,
	toBrowserOptions,
} from "../../src/browser/browser.js"
import { DEFAULTS, type RunConfig } from "../../src/types.js"

describe("toBrowserOptions", () => {
	it("extracts headed and viewport from RunConfig", () => {
		const config: RunConfig = {
			suiteFiles: [],
			reporter: "cli",
			headed: true,
			parallel: 1,
			timeout: 30000,
			viewport: { width: 800, height: 600 },
			model: "anthropic/claude-sonnet-4",
			llmBaseUrl: "https://openrouter.ai/api/v1",
		}
		const opts = toBrowserOptions(config)
		expect(opts.headed).toBe(true)
		expect(opts.viewport).toEqual({ width: 800, height: 600 })
	})
})

describe("browser lifecycle", () => {
	it("launches, creates context and page, then closes", async () => {
		const opts = { headed: false, viewport: DEFAULTS.viewport }
		const browser = await launchBrowser(opts)

		expect(browser.isConnected()).toBe(true)

		const context = await createContext(browser, opts)
		const page = await createPage(context)

		await page.goto("data:text/html,<h1>Hello</h1>")
		const title = await page.locator("h1").textContent()
		expect(title).toBe("Hello")

		await context.close()
		await closeBrowser(browser)

		expect(browser.isConnected()).toBe(false)
	})

	it("applies viewport dimensions to context", async () => {
		const opts = { headed: false, viewport: { width: 640, height: 480 } }
		const browser = await launchBrowser(opts)
		const context = await createContext(browser, opts)
		const page = await createPage(context)

		const size = page.viewportSize()
		expect(size).toEqual({ width: 640, height: 480 })

		await context.close()
		await closeBrowser(browser)
	})
})
