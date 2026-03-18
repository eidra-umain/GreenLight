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

/** ARIA role → CSS selectors that match elements with that implicit role. */
const ROLE_SELECTORS: Record<string, string> = {
	button: "button, [role='button'], input[type='button'], input[type='submit']",
	link: "a[href], [role='link']",
	textbox: "input:not([type]), input[type='text'], input[type='email'], input[type='tel'], input[type='url'], input[type='search'], input[type='password'], input[type='number'], textarea, [role='textbox']",
	combobox: "[role='combobox'], select",
	searchbox: "input[type='search'], [role='searchbox']",
	checkbox: "input[type='checkbox'], [role='checkbox']",
	radio: "input[type='radio'], [role='radio']",
	switch: "[role='switch']",
	slider: "input[type='range'], [role='slider']",
	spinbutton: "input[type='number'], [role='spinbutton']",
	tab: "[role='tab']",
	option: "option, [role='option']",
	menuitem: "[role='menuitem']",
	menuitemcheckbox: "[role='menuitemcheckbox']",
	menuitemradio: "[role='menuitemradio']",
	heading: "h1, h2, h3, h4, h5, h6, [role='heading']",
	img: "img[alt], [role='img']",
}

/** Roles where we extract placeholder + value instead of innerText. */
const INPUT_ROLES = new Set(["textbox", "combobox", "searchbox", "spinbutton", "slider"])

/**
 * Enrich a11y nodes with visible text, placeholder, and value from the DOM.
 * Uses a single page.evaluate() call to extract data for all elements at once,
 * then maps results back to a11y nodes by role + accessible name.
 */
async function enrichA11yNodes(page: Page, nodes: A11yNode[]): Promise<void> {
	// Collect all enrichable nodes (those with real refs)
	const targets: { ref: string; role: string; name: string }[] = []
	function collect(list: A11yNode[]) {
		for (const node of list) {
			if (!node.ref.startsWith("_") && ENRICHABLE_ROLES.has(node.role)) {
				targets.push({ ref: node.ref, role: node.role, name: node.name })
			}
			if (node.children) collect(node.children)
		}
	}
	collect(nodes)
	if (targets.length === 0) return

	// Build a lookup of all needed roles
	const neededRoles = [...new Set(targets.map((t) => t.role))]
	const selectorMap: Record<string, string> = {}
	for (const role of neededRoles) {
		if (ROLE_SELECTORS[role]) selectorMap[role] = ROLE_SELECTORS[role]
	}

	// Single evaluate: find all matching elements and extract their data
	type ElementData = { role: string; name: string; text?: string; placeholder?: string; value?: string }
	const allData = await page.evaluate((selMap) => {
		const results: ElementData[] = []

		function getAccessibleName(el: Element): string {
			// aria-label takes precedence
			const ariaLabel = el.getAttribute("aria-label")
			if (ariaLabel) return ariaLabel.trim()
			// aria-labelledby
			const labelledBy = el.getAttribute("aria-labelledby")
			if (labelledBy) {
				const parts = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
				const joined = parts.join(" ").trim()
				if (joined) return joined
			}
			// For inputs: associated label
			if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
				if (el.id) {
					const label = document.querySelector(`label[for="${el.id}"]`)
					if (label) return label.textContent?.trim() ?? ""
				}
			}
			// placeholder as name for inputs
			if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
				if (el.placeholder) return el.placeholder.trim()
			}
			// alt text for images
			if (el instanceof HTMLImageElement) return (el.alt ?? "").trim()
			// title attribute
			const title = el.getAttribute("title")
			if (title) return title.trim()
			// innerText for buttons, links, headings
			return (el.textContent ?? "").trim().slice(0, 200)
		}

		const inputRoles = new Set(["textbox", "combobox", "searchbox", "spinbutton", "slider"])

		for (const [role, selector] of Object.entries(selMap)) {
			const elements = document.querySelectorAll(selector)
			for (const el of elements) {
				const name = getAccessibleName(el)
				const entry: ElementData = { role, name }

				if (inputRoles.has(role)) {
					const inp = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
					if ("placeholder" in inp && inp.placeholder) entry.placeholder = inp.placeholder
					if ("value" in inp && inp.value) entry.value = inp.value
				} else {
					const text = (el.textContent ?? "").trim().slice(0, 200)
					if (text && text !== name) entry.text = text
				}

				results.push(entry)
			}
		}
		return results
	}, selectorMap).catch(() => [] as ElementData[])

	// Build a lookup map: "role:name" → data (first match wins)
	const dataMap = new Map<string, ElementData>()
	for (const d of allData) {
		const key = `${d.role}:${d.name}`
		if (!dataMap.has(key)) dataMap.set(key, d)
	}

	// Map back to a11y nodes
	const nodeMap = new Map<string, A11yNode>()
	function buildNodeMap(list: A11yNode[]) {
		for (const node of list) {
			nodeMap.set(node.ref, node)
			if (node.children) buildNodeMap(node.children)
		}
	}
	buildNodeMap(nodes)

	for (const target of targets) {
		const data = dataMap.get(`${target.role}:${target.name}`)
		if (!data) continue
		const node = nodeMap.get(target.ref)
		if (!node) continue
		if (data.text) node.visibleText = data.text
		if (data.placeholder) node.placeholder = data.placeholder
		if (data.value) node.value = data.value
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
