/**
 * Assertion execution — validates page state against expected conditions.
 */

import type { Page } from "playwright"
import type { Action, A11yNode, MapState } from "../reporter/types.js"
import type { MapAdapter } from "../map/types.js"
import { globals } from "../globals.js"
import { resolveActionTarget } from "./locator.js"

/**
 * Poll an assertion until it passes or the timeout expires.
 * This handles cases where the page is still updating (e.g. dropdown
 * appearing after typing, navigation completing, etc.).
 */
export async function pollAssertion(
	check: () => Promise<void>,
	timeoutMs = 5000,
): Promise<void> {
	const deadline = performance.now() + timeoutMs
	let lastError: Error = new Error("Assertion timed out")
	while (performance.now() < deadline) {
		try {
			await check()
			return
		} catch (err) {
			lastError = err instanceof Error ? err : new Error(String(err))
		}
		await new Promise((r) => setTimeout(r, 250))
	}
	throw lastError
}

/**
 * Execute an assertion against the current page state.
 * Positive assertions (checking something exists/appears) are polled with
 * a timeout to handle async page updates (dropdowns, navigation, etc.).
 * Negative assertions (checking something is absent) run once immediately.
 */
export async function executeAssertion(
	page: Page,
	action: Action,
	a11yTree: A11yNode[],
	mapContext?: { state?: MapState; adapter?: MapAdapter },
): Promise<void> {
	const assertion = action.assertion
	if (!assertion) {
		throw new Error("executeAssertion called without an assertion")
	}

	// Handle compare assertions separately — they need the value store
	if (assertion.type === "compare" && action.compare) {
		await executeCompareAssertion(page, action, a11yTree)
		return
	}

	// Handle map state assertions — evaluate against captured map viewport + features
	if (assertion.type === "map_state") {
		await executeMapAssertion(page, assertion.expected, mapContext)
		return
	}

	const check = buildAssertionCheck(page, assertion)

	// Positive assertions benefit from polling (content may still be loading).
	// Negative assertions and URL checks should fail immediately.
	const shouldPoll =
		assertion.type === "contains_text" ||
		assertion.type === "element_visible" ||
		assertion.type === "element_exists" ||
		assertion.type === "link_exists" ||
		assertion.type === "field_exists"

	if (shouldPoll) {
		await pollAssertion(check)
	} else {
		await check()
	}
}

/** Extract a numeric value from a text string. */
export function extractNumber(text: string): number | null {
	// Remove thousand separators and normalize decimal separators
	const cleaned = text.replace(/\s/g, "").replace(/,/g, ".")
	const match = /(-?\d+\.?\d*)/.exec(cleaned)
	return match ? parseFloat(match[1]) : null
}

/**
 * Execute a compare assertion: read a current value from the page,
 * compare it against a remembered value using the specified operator.
 */
export async function executeCompareAssertion(
	page: Page,
	action: Action,
	a11yTree: A11yNode[],
): Promise<void> {
	if (!action.compare) {
		throw new Error("executeCompareAssertion called without compare metadata")
	}
	const { variable, operator } = action.compare

	// Get the remembered value from the global value store
	if (!globals.valueStore.has(variable)) {
		throw new Error(`No remembered value found for "${variable}"`)
	}
	const rememberedText = globals.valueStore.get(variable)
	if (rememberedText === undefined) {
		throw new Error(`No remembered value found for "${variable}"`)
	}

	// Get the current value from the page
	let currentText: string
	if (action.ref || action.text) {
		const locator = await resolveActionTarget(page, action, a11yTree)
		currentText = (await locator.textContent() ?? "").trim()
	} else {
		// No element target — use keyword search on the page (same approach
		// as the remember fallback). Extract keywords from the variable name
		// and find a matching text segment containing a number.
		const keywords = variable
			.replace(/_/g, " ")
			.split(" ")
			.filter((w) => w.length > 2)
		const innerText = await page.locator("body").innerText()
		const segments = innerText
			.split(/[\n\t]+/)
			.map((s) => s.trim())
			.filter(Boolean)
		let best = ""
		for (const seg of segments) {
			if (!/\d/.test(seg)) continue
			const lower = seg.toLowerCase()
			if (keywords.some((kw) => lower.includes(kw.toLowerCase()))) {
				if (!best || seg.length < best.length) {
					best = seg
				}
			}
		}
		if (!best) {
			throw new Error(
				`compare assertion: could not find a value on the page matching "${variable}"`,
			)
		}
		currentText = best
		if (globals.debug) {
			console.log(`      [compare] Found current value by keyword search: "${currentText}"`)
		}
	}

	const rememberedNum = extractNumber(rememberedText)
	const currentNum = extractNumber(currentText)

	if (rememberedNum === null) {
		throw new Error(`Cannot extract number from remembered value "${rememberedText}"`)
	}
	if (currentNum === null) {
		throw new Error(`Cannot extract number from current value "${currentText}"`)
	}

	if (globals.debug) {
		console.log(`      [compare] "${variable}" = ${String(rememberedNum)}, current = ${String(currentNum)}, operator = ${operator}`)
	}

	let passed: boolean
	switch (operator) {
		case "less_than": passed = currentNum < rememberedNum; break
		case "greater_than": passed = currentNum > rememberedNum; break
		case "equal": passed = currentNum === rememberedNum; break
		case "not_equal": passed = currentNum !== rememberedNum; break
		case "less_or_equal": passed = currentNum <= rememberedNum; break
		case "greater_or_equal": passed = currentNum >= rememberedNum; break
		default: throw new Error(`Unknown comparison operator: ${String(operator)}`)
	}

	if (!passed) {
		throw new Error(
			`Comparison failed: current value ${String(currentNum)} is not ${operator.replace(/_/g, " ")} remembered "${variable}" (${String(rememberedNum)})`,
		)
	}
}

export function buildAssertionCheck(
	page: Page,
	assertion: { type: string; expected: string },
): () => Promise<void> {
	return async () => {
		switch (assertion.type) {
			case "contains_text": {
				const body = await page.locator("body").textContent()
				if (!body?.toLowerCase().includes(assertion.expected.toLowerCase())) {
					throw new Error(`Page does not contain text: "${assertion.expected}"`)
				}
				break
			}

			case "not_contains_text": {
				const bodyText = await page.locator("body").textContent()
				if (
					bodyText?.toLowerCase().includes(assertion.expected.toLowerCase())
				) {
					throw new Error(
						`Page contains text it should not: "${assertion.expected}"`,
					)
				}
				break
			}

			case "url_contains": {
				const url = page.url()
				if (!url.includes(assertion.expected)) {
					throw new Error(
						`URL "${url}" does not contain "${assertion.expected}"`,
					)
				}
				break
			}

			case "element_visible":
			case "element_exists": {
				const visible = await page.getByText(assertion.expected).isVisible()
				if (!visible) {
					throw new Error(
						`Element with text "${assertion.expected}" is not visible`,
					)
				}
				break
			}

			case "element_not_visible": {
				const visible = await page.getByText(assertion.expected).isVisible()
				if (visible) {
					throw new Error(
						`Element with text "${assertion.expected}" is still visible`,
					)
				}
				break
			}

			case "link_exists": {
				const link = page.locator(
					`a[href="${assertion.expected}"], a[href$="${assertion.expected}"]`,
				)
				const count = await link.count()
				if (count === 0) {
					throw new Error(
						`No link found with href matching "${assertion.expected}"`,
					)
				}
				break
			}

			case "field_exists": {
				// Check for a form field by label, placeholder, or aria-label
				const byLabel = page.getByLabel(assertion.expected)
				const byPlaceholder = page.getByPlaceholder(assertion.expected)
				const labelCount = await byLabel.count()
				const placeholderCount = await byPlaceholder.count()
				if (labelCount === 0 && placeholderCount === 0) {
					throw new Error(
						`No form field found matching "${assertion.expected}"`,
					)
				}
				break
			}

			default:
				throw new Error(`Unknown assertion type: ${assertion.type}`)
		}
	}
}

// ── Map state assertions ─────────────────────────────────────────────

/**
 * Query all rendered features via the adapter and search for one whose
 * "name" property matches the search term (case-insensitive).
 */
async function findFeatureByName(
	page: Page,
	adapter: MapAdapter,
	searchName: string,
): Promise<{ found: boolean; layer?: string; name?: string }> {
	const features = await adapter.queryRenderedFeatures(page)
	const lower = searchName.toLowerCase()
	for (const f of features) {
		const name = f.properties?.name
		if (typeof name === "string" && name.toLowerCase().includes(lower)) {
			return { found: true, layer: f.layer, name }
		}
	}
	return { found: false }
}

/**
 * Evaluate a map state assertion.
 *
 * Supports three categories:
 * 1. **Feature search** — "map shows Örebro" → queries rendered features
 *    for a name match. This is the primary approach for location assertions.
 * 2. **Zoom checks** — "zoom level is at least 10"
 * 3. **Layer checks** — "layer hospitals is visible"
 */
async function executeMapAssertion(
	page: Page,
	expected: string,
	mapContext?: { state?: MapState; adapter?: MapAdapter },
): Promise<void> {
	const mapState = mapContext?.state
	if (!mapState) {
		throw new Error("Map state assertion failed: no map state available (was MAP_DETECT successful?)")
	}

	const lower = expected.toLowerCase()

	if (globals.debug) {
		console.log(`      [map-assert] Evaluating: "${expected}"`)
		console.log(`      [map-assert] Map center: ${mapState.center.lng.toFixed(4)}, ${mapState.center.lat.toFixed(4)} zoom: ${mapState.zoom.toFixed(2)}`)
	}

	// ── Zoom checks ──
	const zoomMatch = /zoom\s*(?:level)?\s*(?:is\s+)?(?:(?:at\s+least|>=?|greater\s+than\s+or\s+equal)\s+(\d+(?:\.\d+)?)|(?:at\s+most|<=?|less\s+than\s+or\s+equal)\s+(\d+(?:\.\d+)?)|(?:exactly|=|equals?)\s+(\d+(?:\.\d+)?)|(?:greater\s+than|>)\s+(\d+(?:\.\d+)?)|(?:less\s+than|<)\s+(\d+(?:\.\d+)?))/i.exec(lower)
	if (zoomMatch) {
		const [, atLeast, atMost, exactly, greaterThan, lessThan] = zoomMatch
		if (atLeast && mapState.zoom < parseFloat(atLeast)) {
			throw new Error(`Map zoom ${mapState.zoom.toFixed(2)} is less than expected minimum ${atLeast}`)
		}
		if (atMost && mapState.zoom > parseFloat(atMost)) {
			throw new Error(`Map zoom ${mapState.zoom.toFixed(2)} is greater than expected maximum ${atMost}`)
		}
		if (exactly && Math.abs(mapState.zoom - parseFloat(exactly)) > 0.5) {
			throw new Error(`Map zoom ${mapState.zoom.toFixed(2)} does not match expected ${exactly}`)
		}
		if (greaterThan && mapState.zoom <= parseFloat(greaterThan)) {
			throw new Error(`Map zoom ${mapState.zoom.toFixed(2)} is not greater than ${greaterThan}`)
		}
		if (lessThan && mapState.zoom >= parseFloat(lessThan)) {
			throw new Error(`Map zoom ${mapState.zoom.toFixed(2)} is not less than ${lessThan}`)
		}
		if (globals.debug) {
			console.log(`      [map-assert] Zoom check passed`)
		}
		return
	}

	// ── Layer checks ──
	const layerMatch = /(?:layer|layers?)\s+["']?([^"']+)["']?\s+(?:is\s+)?(?:visible|exists?|present|shown|active)/i.exec(expected)
	if (layerMatch) {
		const layerName = layerMatch[1].trim().toLowerCase()
		const found = mapState.layers.some((l) => l.toLowerCase().includes(layerName))
		if (!found) {
			throw new Error(
				`Layer "${layerMatch[1].trim()}" not found in map layers: ${mapState.layers.slice(0, 20).join(", ")}`,
			)
		}
		if (globals.debug) {
			console.log(`      [map-assert] Layer check passed`)
		}
		return
	}

	// ── Feature search (default) ──
	// Extract the search term: text in quotes, or after "shows"/"displays"/"contains",
	// or the entire expected string as a fallback.
	let searchTerm: string | null = null
	const quotedMatch = /["'""]([^"'""]+)["'""]/.exec(expected)
	if (quotedMatch) {
		searchTerm = quotedMatch[1]
	} else {
		const verbMatch = /(?:shows?|displays?|contains?|includes?|has|visible)\s+(.+)/i.exec(expected)
		if (verbMatch) {
			searchTerm = verbMatch[1].trim()
		}
	}

	if (searchTerm) {
		const adapter = mapContext?.adapter
		if (!adapter) {
			throw new Error("Map feature assertion failed: no map adapter available (was MAP_DETECT successful?)")
		}
		if (globals.debug) {
			console.log(`      [map-assert] Searching rendered features for "${searchTerm}"`)
		}
		const result = await findFeatureByName(page, adapter, searchTerm)
		if (!result.found) {
			throw new Error(
				`Map does not show "${searchTerm}" — no rendered feature with a matching name found in the current viewport`,
			)
		}
		if (globals.debug) {
			console.log(`      [map-assert] Found feature "${result.name ?? ""}" in layer "${result.layer ?? ""}"`)
		}
		return
	}

	throw new Error(
		`Could not evaluate map assertion: "${expected}". ` +
		`Map state: center=(${mapState.center.lng.toFixed(4)}, ${mapState.center.lat.toFixed(4)}), ` +
		`zoom=${mapState.zoom.toFixed(2)}`,
	)
}
