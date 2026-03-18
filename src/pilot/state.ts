/**
 * Page state capture: accessibility tree snapshots, screenshots, and console logs.
 *
 * Sub-modules:
 *   - ./network.ts       — network idle tracking, console collector
 *   - ./a11y-parser.ts   — a11y snapshot parsing with stable refs
 *   - ./form-fields.ts   — form field capture and formatting
 */

import type { Page } from "playwright"
import type { A11yNode, ConsoleEntry, PageState } from "../reporter/types.js"
import type { MapAdapter } from "../map/types.js"
import { captureMapState } from "../map/index.js"
import { parseA11ySnapshot } from "./a11y-parser.js"

// ── Enrichment ───────────────────────────────────────────────────────

/**
 * Roles where DOM enrichment adds value beyond the a11y name.
 * These are elements the user interacts with or reads values from.
 */
const ENRICHABLE_ROLES = new Set([
	"textbox",
	"combobox",
	"searchbox",
	"spinbutton",
	"slider",
	"button",
	"link",
	"heading",
	"checkbox",
	"radio",
	"tab",
	"switch",
	"option",
	"menuitem",
	"menuitemcheckbox",
	"menuitemradio",
	"img",
])

type AriaRole = Parameters<Page["getByRole"]>[0]

/**
 * Enrich a11y nodes with visible text, placeholder, and value from the DOM.
 * Uses Playwright locators (getByRole) to find each element and extract
 * properties in batched parallel lookups.
 */
async function enrichA11yNodes(page: Page, nodes: A11yNode[]): Promise<void> {
	// Collect all enrichable nodes (those with real refs)
	const targets: A11yNode[] = []
	function collect(list: A11yNode[]) {
		for (const node of list) {
			if (!node.ref.startsWith("_") && ENRICHABLE_ROLES.has(node.role)) {
				targets.push(node)
			}
			if (node.children) collect(node.children)
		}
	}
	collect(nodes)

	// Process in batches to limit concurrency
	const BATCH_SIZE = 10
	for (let i = 0; i < targets.length; i += BATCH_SIZE) {
		const batch = targets.slice(i, i + BATCH_SIZE)
		await Promise.all(batch.map(async (node) => {
			try {
				const role = node.role as AriaRole
				const locator = node.name
					? page.getByRole(role, { name: node.name, exact: true }).first()
					: page.getByRole(role).first()

				// Check visibility first — skip offscreen/hidden elements
				if (!await locator.isVisible().catch(() => false)) return

				const [text, placeholder, value] = await Promise.all([
					locator.innerText().catch(() => undefined),
					locator.getAttribute("placeholder").catch(() => undefined),
					locator.inputValue().catch(() => undefined),
				])

				// Only store non-redundant data
				if (text) {
					const trimmed = text.trim().slice(0, 200)
					if (trimmed && trimmed !== node.name) {
						node.visibleText = trimmed
					}
				}
				if (placeholder) {
					node.placeholder = placeholder
				}
				if (value) {
					node.value = value
				}
			} catch {
				// Element may not be found or page navigated — skip
			}
		}))
	}
}

// ── Orchestrator ──────────────────────────────────────────────────────

/**
 * Capture the page state: a11y tree (enriched with DOM data), URL, title, console logs.
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

	// Enrich a11y nodes with visible text, placeholder, and value from the DOM
	await enrichA11yNodes(page, a11yTree)

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

	return { a11yTree, a11yRaw, screenshot, url, title, consoleLogs, mapState }
}
