/**
 * Action executor — translates LLM Action objects into Playwright browser calls.
 */

import type { Page, Locator } from "playwright"
import type { Action, A11yNode, ExecutionResult } from "../reporter/types.js"

/**
 * Find an A11yNode by its ref ID, searching the tree recursively.
 */
export function findNodeByRef(
	nodes: A11yNode[],
	ref: string,
): A11yNode | undefined {
	for (const node of nodes) {
		if (node.ref === ref) return node
		if (node.children) {
			const found = findNodeByRef(node.children, ref)
			if (found) return found
		}
	}
	return undefined
}

/**
 * Find the path from root to a node by ref.
 * Returns the chain of ancestor nodes including the target, or undefined.
 */
export function findNodePath(
	nodes: A11yNode[],
	ref: string,
	path: A11yNode[] = [],
): A11yNode[] | undefined {
	for (const node of nodes) {
		const currentPath = [...path, node]
		if (node.ref === ref) return currentPath
		if (node.children) {
			const found = findNodePath(node.children, ref, currentPath)
			if (found) return found
		}
	}
	return undefined
}

type AriaRole = Parameters<Page["getByRole"]>[0]

/**
 * Given a locator, return it if it matches exactly one element,
 * or return the first visible match if there are several.
 * Returns undefined if the locator matches nothing.
 */
async function pickVisible(locator: Locator): Promise<Locator | undefined> {
	try {
		const count = await locator.count()
		if (count === 1) return locator
		if (count > 1) {
			for (let i = 0; i < count; i++) {
				const nth = locator.nth(i)
				if (await nth.isVisible()) return nth
			}
		}
	} catch {
		// Locator failed entirely
	}
	return undefined
}

function roleLocator(scope: Page | Locator, node: A11yNode): Locator {
	const role = node.role as AriaRole
	if (node.name) {
		return scope.getByRole(role, { name: node.name, exact: true })
	}
	return scope.getByRole(role)
}

/**
 * Resolve an element ref to a Playwright locator using the a11y tree hierarchy.
 *
 * Primary strategy: chain getByRole calls from ancestor → target using the
 * same tree structure that ariaSnapshot reported. This disambiguates elements
 * that share the same role+name but live under different parents.
 *
 * Fallback strategies (tried in order if chained locator doesn't match):
 *   1. Direct getByRole (ignoring hierarchy)
 *   2. getByLabel (for form inputs)
 *   3. getByPlaceholder (for text inputs)
 * Returns the first locator that resolves to a single visible element.
 */
export async function resolveLocator(
	page: Page,
	nodes: A11yNode[],
	ref: string,
): Promise<Locator> {
	const path = findNodePath(nodes, ref)
	if (!path || path.length === 0) {
		throw new Error(`Element ref "${ref}" not found in accessibility tree`)
	}

	const target = path[path.length - 1]
	const role = target.role as AriaRole

	// Build candidates list, best to worst
	const candidates: Locator[] = []

	// 1. Chained locator using ancestor hierarchy
	//    Use named ancestors to scope the search progressively
	if (path.length > 1) {
		let scoped: Locator | undefined
		for (const ancestor of path.slice(0, -1)) {
			// Only chain through named nodes — unnamed structural nodes
			// (like bare "list" or "main") add noise without disambiguation
			if (!ancestor.name) continue
			scoped = roleLocator(scoped ?? page, ancestor)
		}
		if (scoped) {
			candidates.push(roleLocator(scoped, target))
		}
	}

	// 2. Direct getByRole with exact name
	if (target.name) {
		candidates.push(page.getByRole(role, { name: target.name, exact: true }))
	}

	// 3. getByLabel (finds inputs by associated label text)
	if (target.name) {
		candidates.push(page.getByLabel(target.name, { exact: true }))
	}

	// 4. getByPlaceholder (finds inputs by placeholder attribute)
	if (target.name) {
		candidates.push(page.getByPlaceholder(target.name, { exact: true }))
	}

	// 5. Direct getByRole with loose name match
	if (target.name) {
		candidates.push(page.getByRole(role, { name: target.name }))
	}

	// Try each candidate: return the first that matches exactly one element,
	// or the first visible element when there are multiple matches.
	for (const locator of candidates) {
		const match = await pickVisible(locator)
		if (match) return match
	}

	// Last resort — return the basic locator and let Playwright handle errors
	if (target.name) {
		return page.getByRole(role, { name: target.name })
	}
	return page.getByRole(role)
}

/**
 * Resolve an element by its visible text content.
 * Used as a fallback when the element isn't in the accessibility tree
 * (e.g. due to missing ARIA roles in the page markup).
 */
async function resolveByText(page: Page, text: string): Promise<Locator> {
	const candidates: Locator[] = [
		// Exact text match (link, button, or any element)
		page.getByRole("link", { name: text, exact: true }),
		page.getByRole("button", { name: text, exact: true }),
		page.getByText(text, { exact: true }),
		// Loose match
		page.getByRole("link", { name: text }),
		page.getByRole("button", { name: text }),
		page.getByText(text),
	]

	for (const locator of candidates) {
		const match = await pickVisible(locator)
		if (match) return match
	}

	// Last resort — let Playwright handle the error
	return page.getByText(text)
}

/**
 * Resolve a locator from an action's ref or text field.
 */
async function resolveActionTarget(
	page: Page,
	action: Action,
	a11yTree: A11yNode[],
): Promise<Locator> {
	if (action.ref) {
		return resolveLocator(page, a11yTree, action.ref)
	}
	if (action.text) {
		return resolveByText(page, action.text)
	}
	throw new Error(`${action.action} action requires a ref or text target`)
}

/**
 * Run an action that might trigger navigation.
 * Listens for a 'framenavigated' event during the action — if one fires,
 * waits for the new page to reach domcontentloaded. If no navigation
 * happens, returns immediately with no delay.
 */
async function runWithNavigationHandling(
	page: Page,
	action: () => Promise<void>,
): Promise<void> {
	// Track whether the action triggers a navigation via event callback.
	// The flag is mutated asynchronously by the event handler.
	const state = { navigated: false }
	const onNav = () => {
		state.navigated = true
	}

	page.on("framenavigated", onNav)
	try {
		await action()
		if (state.navigated) {
			await page.waitForLoadState("domcontentloaded")
		}
	} finally {
		page.off("framenavigated", onNav)
	}
}

/**
 * Execute a single Action against the browser page.
 */
export async function executeAction(
	page: Page,
	action: Action,
	a11yTree: A11yNode[],
): Promise<ExecutionResult> {
	const start = performance.now()

	try {
		switch (action.action) {
			case "click": {
				const locator = await resolveActionTarget(page, action, a11yTree)
				await runWithNavigationHandling(page, () => locator.click())
				break
			}

			case "type": {
				if (!action.value) {
					throw new Error("type action requires a value")
				}
				const locator = await resolveActionTarget(page, action, a11yTree)
				// Click the target to focus/activate it (may open an input overlay).
				// Use navigation handling in case the click triggers a page change.
				await runWithNavigationHandling(page, () => locator.click())
				// Clear existing content and type character-by-character
				// via the keyboard, triggering proper JS events
				await page.keyboard.press("Control+A")
				await page.keyboard.press("Backspace")
				await page.keyboard.type(action.value, { delay: 30 })
				break
			}

			case "select": {
				if (!action.value) {
					throw new Error("select action requires a value")
				}
				const locator = await resolveActionTarget(page, action, a11yTree)
				await locator.selectOption({ label: action.value })
				break
			}

			case "scroll": {
				if (action.ref) {
					const locator = await resolveLocator(page, a11yTree, action.ref)
					await locator.scrollIntoViewIfNeeded()
				} else {
					const delta = action.value === "up" ? -500 : 500
					await page.mouse.wheel(0, delta)
				}
				break
			}

			case "press": {
				if (!action.value) {
					throw new Error("press action requires a value")
				}
				const key = action.value
				await runWithNavigationHandling(page, () => page.keyboard.press(key))
				break
			}

			case "navigate": {
				if (!action.value) {
					throw new Error("navigate action requires a value")
				}
				const url = action.value.startsWith("/")
					? new URL(action.value, page.url()).href
					: action.value
				await page.goto(url, { waitUntil: "domcontentloaded" })
				break
			}

			case "wait": {
				if (!action.value) {
					throw new Error("wait action requires a value")
				}
				// Wait for text to appear on the page
				await page.getByText(action.value).waitFor({ state: "visible" })
				break
			}

			case "assert": {
				if (!action.assertion) {
					throw new Error("assert action requires an assertion")
				}
				await executeAssertion(page, action.assertion)
				break
			}

			default:
				throw new Error(`Unknown action: ${action.action}`)
		}

		return {
			success: true,
			duration: performance.now() - start,
		}
	} catch (err) {
		return {
			success: false,
			duration: performance.now() - start,
			error: err instanceof Error ? err.message : String(err),
		}
	}
}

/**
 * Poll an assertion until it passes or the timeout expires.
 * This handles cases where the page is still updating (e.g. dropdown
 * appearing after typing, navigation completing, etc.).
 */
async function pollAssertion(
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
async function executeAssertion(
	page: Page,
	assertion: { type: string; expected: string },
): Promise<void> {
	const check = buildAssertionCheck(page, assertion)

	// Positive assertions benefit from polling (content may still be loading).
	// Negative assertions and URL checks should fail immediately.
	const shouldPoll =
		assertion.type === "contains_text" ||
		assertion.type === "element_visible" ||
		assertion.type === "link_exists" ||
		assertion.type === "field_exists"

	if (shouldPoll) {
		await pollAssertion(check)
	} else {
		await check()
	}
}

function buildAssertionCheck(
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

			case "element_visible": {
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
