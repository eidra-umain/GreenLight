/**
 * Page state capture: accessibility tree snapshots, screenshots, and console logs.
 *
 * Sub-modules:
 *   - ./network.ts       — network idle tracking, console collector
 *   - ./a11y-parser.ts   — a11y snapshot parsing with stable refs
 *   - ./form-fields.ts   — form field capture and formatting
 */

import type { Page } from "playwright"
import type { ConsoleEntry, PageState } from "../reporter/types.js"
import type { MapAdapter } from "../map/types.js"
import { captureMapState } from "../map/index.js"
import { parseA11ySnapshot } from "./a11y-parser.js"

// ── Orchestrator ──────────────────────────────────────────────────────

/**
 * Capture the page state: a11y tree, URL, title, console logs.
 * Screenshots are optional — skip them on pre-action captures to avoid
 * triggering lazy-loaded elements (e.g. IntersectionObserver-based maps).
 */
export async function capturePageState(
	page: Page,
	consoleDrain: () => ConsoleEntry[],
	options?: { screenshot?: boolean; mapAdapter?: MapAdapter },
): Promise<PageState> {
	const takeScreenshot = options?.screenshot ?? false

	const [a11yRaw, screenshotBuffer, url, title] = await Promise.all([
		page.locator("body").ariaSnapshot(),
		takeScreenshot ? page.screenshot({ type: "png" }) : Promise.resolve(null),
		Promise.resolve(page.url()),
		page.title(),
	])

	const a11yTree = parseA11ySnapshot(a11yRaw)

	// Capture all text content on the page. This supplements the a11y tree
	// which can miss content rendered with non-semantic markup.
	// We use textContent (not innerText) because innerText skips elements
	// hidden by CSS transitions/animations that are still interactive.
	// Script and style content is excluded.
	let visibleText: string | undefined
	try {
		const raw = await page.evaluate(() => {
			function walk(node: Node): string {
				if (node.nodeType === 3) return node.textContent ?? "" // TEXT_NODE
				if (node.nodeType !== 1) return "" // Only process ELEMENT_NODE
				const el = node as Element
				const tag = el.tagName
				if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT")
					return ""
				const parts: string[] = []
				for (const child of el.childNodes) {
					parts.push(walk(child))
				}
				return parts.join("")
			}
			return walk(document.body)
		})
		// Collapse whitespace runs into single spaces, trim blank lines
		visibleText =
			raw
				.split("\n")
				.map((l) => l.replace(/\s+/g, " ").trim())
				.filter((l) => l.length > 0)
				.join("\n") || undefined
	} catch {
		// Skip if page is mid-navigation
	}

	const screenshot = screenshotBuffer
		? screenshotBuffer.toString("base64")
		: undefined
	const consoleLogs = consoleDrain()

	// Capture map state if a map adapter is active
	let mapState: PageState["mapState"]
	if (options?.mapAdapter) {
		try {
			mapState = await captureMapState(page, options.mapAdapter)
		} catch {
			// Map may have been removed or navigated away — skip silently
		}
	}

	return { a11yTree, a11yRaw, visibleText, screenshot, url, title, consoleLogs, mapState }
}
