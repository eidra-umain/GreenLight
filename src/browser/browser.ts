/**
 * Playwright browser lifecycle management.
 * Wraps launch, context creation, page creation, and cleanup.
 */

import path from "path"
import { createRequire } from "module"
import { chromium, type Browser, type BrowserContext, type Page } from "playwright"
import type { RunConfig } from "../types.js"

export interface BrowserOptions {
	headed: boolean
	viewport: { width: number; height: number }
}

/** Zoom level applied in headed mode (50%). */
const BROWSER_ZOOM = 50

/**
 * Resolve the path to the playwright-zoom extension directory.
 * Uses createRequire because playwright-zoom is a CJS package.
 */
function zoomExtensionPath(): string {
	const require = createRequire(import.meta.url)
	const pwZoomDir = path.dirname(require.resolve("playwright-zoom"))
	return path.join(pwZoomDir, "lib", "zoom-extension")
}

/** Common Chromium flags shared across launch modes. */
const CHROMIUM_ARGS = [
	"--enable-webgl",
	"--enable-webgl2-compute-context",
	"--enable-gpu-rasterization",
	"--ignore-gpu-blocklist",
]

/** Launch a Chromium browser instance. */
export async function launchBrowser(config: BrowserOptions): Promise<Browser> {
	return chromium.launch({
		headless: !config.headed,
		args: CHROMIUM_ARGS,
	})
}

/** Create an isolated browser context with configured viewport. */
export async function createContext(
	browser: Browser,
	config: BrowserOptions,
): Promise<BrowserContext> {
	return browser.newContext({
		viewport: config.viewport,
	})
}

/**
 * Set browser zoom via the playwright-zoom extension.
 * The extension's content script listens for a postMessage and relays
 * it to its service worker which calls chrome.tabs.setZoom().
 */
async function applyBrowserZoom(page: Page, zoom: number): Promise<void> {
	await page.evaluate(
		(browserZoom) => window.postMessage({ type: "setTabZoom", browserZoom }, "*"),
		zoom,
	)
	// Small delay for the extension round-trip
	await page.waitForTimeout(200)
}

/**
 * Launch a persistent browser context with the zoom extension loaded.
 * Used in headed mode to get real 75% browser zoom.
 * Returns a BrowserContext that the caller can create pages from.
 */
export async function launchPersistentContextWithZoom(
	config: BrowserOptions,
): Promise<{ context: BrowserContext }> {
	const extPath = zoomExtensionPath()
	// Set the window size to match the viewport so the browser chrome
	// doesn't add extra space around the rendered page.
	const { width, height } = config.viewport

	// Create a temp user data dir with Chrome prefs that disable translate
	const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs")
	const { join } = await import("node:path")
	const { tmpdir } = await import("node:os")
	const userDataDir = mkdtempSync(join(tmpdir(), "greenlight-chrome-"))
	const defaultDir = join(userDataDir, "Default")
	mkdirSync(defaultDir, { recursive: true })
	writeFileSync(
		join(defaultDir, "Preferences"),
		JSON.stringify({ translate: { enabled: false }, translate_blocked_languages: ["*"] }),
	)

	const context = await chromium.launchPersistentContext(userDataDir, {
		headless: false,
		viewport: config.viewport,
		args: [
			...CHROMIUM_ARGS,
			`--window-size=${String(width)},${String(height)}`,
			"--disable-features=Translate,TranslateUI",
			`--disable-extensions-except=${extPath}`,
			`--load-extension=${extPath}`,
		],
	})

	// The zoom extension opens a tab on load — close it
	const existingPages = context.pages()
	for (const p of existingPages) {
		await p.close().catch(() => {})
	}

	return { context }
}

/** Create a new page within a browser context and inject test mode global. */
export async function createPage(
	context: BrowserContext,
	options?: { headed?: boolean },
): Promise<Page> {
	const page = await context.newPage()
	await page.addInitScript(() => {
		Object.defineProperty(window, "__E2E_TEST__", {
			value: true,
			writable: false,
			configurable: false,
		})
	})

	// IMPORTANT: Custom headers must ONLY be added to same-origin requests.
	// Never use extraHTTPHeaders on the browser context — it adds headers
	// to ALL requests including cross-origin tile/CDN fetches (e.g.
	// DigitalOcean Spaces PMTiles). Non-standard headers trigger CORS
	// preflight (OPTIONS) requests that tile servers don't handle,
	// breaking map tile loading entirely.
	await page.route("**/*", async (route) => {
		const request = route.request()
		if (request.isNavigationRequest() || request.resourceType() === "fetch" || request.resourceType() === "xhr") {
			try {
				const reqUrl = new URL(request.url())
				const pageUrl = new URL(page.url())
				if (reqUrl.origin === pageUrl.origin) {
					await route.continue({
						headers: { ...request.headers(), "X-E2E-Test": "true" },
					})
					return
				}
			} catch { /* page.url() can throw before first navigation */ }
		}
		await route.continue()
	})

	// Apply 75% zoom in headed mode after the first navigation
	if (options?.headed) {
		page.once("load", () => {
			applyBrowserZoom(page, BROWSER_ZOOM).catch(() => {})
		})
	}

	return page
}

/** Close a browser or persistent context. */
export async function closeBrowser(browserOrContext: Browser | BrowserContext): Promise<void> {
	try {
		if ("pages" in browserOrContext) {
			// Persistent context (headed mode).
			// Chrome 145 has a bug where its shutdown code crashes with SIGSEGV,
			// triggering the macOS "quit unexpectedly" dialog. To avoid this,
			// get the browser PID via CDP and SIGKILL it directly — the process
			// never runs its buggy shutdown path.
			const pages = browserOrContext.pages()
			const page = pages[0] ?? await browserOrContext.newPage()
			try {
				const cdp = await browserOrContext.newCDPSession(page)
				const info = await cdp.send("SystemInfo.getProcessInfo") as { processInfo: { type: string; id: number }[] }
				const browserProc = info.processInfo.find((p) => p.type === "browser")
				if (browserProc) {
					process.kill(browserProc.id, "SIGKILL")
					return
				}
			} catch { /* fall through to normal close */ }
		}
		await browserOrContext.close()
	} catch {
		// Browser process may have already exited
	}
}

/** Extract browser options from RunConfig. */
export function toBrowserOptions(config: RunConfig): BrowserOptions {
	return {
		headed: config.headed,
		viewport: config.viewport,
	}
}
