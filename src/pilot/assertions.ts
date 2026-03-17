/**
 * Assertion execution — validates page state against expected conditions.
 */

import type { Page } from "playwright"
import type { Action, A11yNode } from "../reporter/types.js"
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
