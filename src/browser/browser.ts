/**
 * Playwright browser lifecycle management.
 * Wraps launch, context creation, page creation, and cleanup.
 */

import { chromium, type Browser, type BrowserContext, type Page } from "playwright"
import type { RunConfig } from "../types.js"

export interface BrowserOptions {
	headed: boolean
	viewport: { width: number; height: number }
}

/** Launch a Chromium browser instance. */
export async function launchBrowser(config: BrowserOptions): Promise<Browser> {
	return chromium.launch({
		headless: !config.headed,
	})
}

/** Create an isolated browser context with configured viewport and test mode headers. */
export async function createContext(
	browser: Browser,
	config: BrowserOptions,
): Promise<BrowserContext> {
	return browser.newContext({
		viewport: config.viewport,
		extraHTTPHeaders: {
			"X-E2E-Test": "true",
		},
	})
}

/** Create a new page within a browser context and inject test mode global. */
export async function createPage(context: BrowserContext): Promise<Page> {
	const page = await context.newPage()
	await page.addInitScript(() => {
		Object.defineProperty(window, "__E2E_TEST__", {
			value: true,
			writable: false,
			configurable: false,
		})
	})
	return page
}

/** Close the browser and all its contexts. */
export async function closeBrowser(browser: Browser): Promise<void> {
	await browser.close()
}

/** Extract browser options from RunConfig. */
export function toBrowserOptions(config: RunConfig): BrowserOptions {
	return {
		headed: config.headed,
		viewport: config.viewport,
	}
}
