/**
 * Action executor — translates LLM Action objects into Playwright browser calls.
 */

import type { Page, Locator } from "playwright"
import type {
	Action,
	A11yNode,
	ExecutionResult,
	ResolvedSelector,
} from "../reporter/types.js"
import { globals } from "../globals.js"

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
 * Extract a CSS selector from a resolved Playwright locator.
 * Evaluates in-browser to build a unique path-based selector.
 */
async function extractCssSelector(
	locator: Locator,
): Promise<string | undefined> {
	try {
		return await locator.evaluate((el: Element) => {
			const escape = (s: string) => CSS.escape(s)
			if (el.id) return "#" + escape(el.id)
			const parts: string[] = []
			let current: Element | null = el
			while (
				current &&
				current !== document.body &&
				current !== document.documentElement
			) {
				let sel = current.tagName.toLowerCase()
				if (current.id) {
					parts.unshift("#" + escape(current.id))
					break
				}
				const parent = current.parentElement
				if (parent) {
					const sameTag = Array.from(parent.children).filter(
						(c) => c.tagName === current!.tagName,
					)
					if (sameTag.length > 1) {
						sel += `:nth-of-type(${String(sameTag.indexOf(current!) + 1)})`
					}
				}
				parts.unshift(sel)
				current = current.parentElement
			}
			return parts.join(" > ")
		})
	} catch {
		return undefined
	}
}

/**
 * Extract selector info from a resolved action for the plan recorder.
 * For ref-based actions: returns role + name from the a11y node.
 * For text-based actions: extracts a CSS selector from the DOM element.
 */
async function extractSelectorInfo(
	page: Page,
	action: Action,
	a11yTree: A11yNode[],
	locator: Locator,
): Promise<ResolvedSelector | undefined> {
	if (action.ref) {
		const node = findNodeByRef(a11yTree, action.ref)
		if (node) {
			const selector: ResolvedSelector = { role: node.role, name: node.name }
			// Check if multiple elements match this role+name.
			// If so, record which one was acted on (nth index).
			try {
				type AriaRoleParam = Parameters<Page["getByRole"]>[0]
				const allMatches = node.name
					? page.getByRole(node.role as AriaRoleParam, { name: node.name })
					: page.getByRole(node.role as AriaRoleParam)
				const count = await allMatches.count()
				if (count > 1) {
					// Find which nth match our locator corresponds to
					const targetEl = await locator.elementHandle()
					for (let i = 0; i < count; i++) {
						const matchEl = await allMatches.nth(i).elementHandle()
						if (targetEl && matchEl && await targetEl.evaluate(
							(a, b) => a === b, matchEl,
						)) {
							selector.nth = i
							break
						}
					}
				}
			} catch {
				// If counting fails, proceed without nth
			}
			return selector
		}
	}
	if (action.text) {
		const css = await extractCssSelector(locator)
		if (css) return { css }
	}
	return undefined
}

/**
 * Run an action that might trigger navigation.
 * Listens for a 'framenavigated' event during the action — if one fires,
 * waits for the new page to reach domcontentloaded. If no navigation
 * happens, returns immediately with no delay.
 */
export async function runWithNavigationHandling(
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
 * Check or uncheck a checkbox using multiple strategies.
 * Modern frameworks (React, Vue, etc.) use synthetic event systems that
 * don't respond to native DOM property changes. We try multiple approaches
 * in order until the checkbox state actually changes.
 */
async function checkCheckbox(
	page: Page,
	locator: Locator,
	checked: boolean,
): Promise<void> {
	const method = checked ? "check" : "uncheck"

	// Strategy 1: Playwright's native check/uncheck (works for standard checkboxes)
	try {
		if (checked) {
			await locator.check({ timeout: 3000 })
		} else {
			await locator.uncheck({ timeout: 3000 })
		}
		return
	} catch {
		if (globals.debug) {
			console.log(`      [${method}] Playwright ${method}() timed out, trying label click`)
		}
	}

	// Strategy 2: Find and click the associated <label> element.
	// This is the most reliable approach for custom-styled checkboxes
	// because it mimics what a real user does.
	try {
		const labelClicked = await locator.evaluate((el: HTMLElement) => {
			// If this IS the input, find its label
			let input: HTMLInputElement | null = null
			if (el.tagName === "INPUT") {
				input = el as HTMLInputElement
			} else {
				input = el.querySelector("input[type='checkbox']")
			}
			if (!input) return false

			// Try label[for="id"]
			if (input.id) {
				const label = document.querySelector(`label[for="${input.id}"]`)
				if (label) {
					(label as HTMLElement).click()
					return true
				}
			}
			// Try wrapping <label>
			const label = input.closest("label")
			if (label) {
				label.click()
				return true
			}
			return false
		})
		if (labelClicked) {
			if (globals.debug) {
				console.log(`      [${method}] Label click succeeded`)
			}
			return
		}
	} catch {
		// Continue to next strategy
	}

	// Strategy 3: Force click the element itself
	try {
		await locator.click({ force: true, timeout: 2000 })
		if (globals.debug) {
			console.log(`      [${method}] Force click succeeded`)
		}
		return
	} catch {
		if (globals.debug) {
			console.log(`      [${method}] Force click failed, using JS property set + React workaround`)
		}
	}

	// Strategy 4: Set the property and fire React-compatible events.
	// React uses an internal event system that tracks the input's value
	// via a property descriptor override. We need to use the native
	// setter and then dispatch events to trigger React's onChange.
	await locator.evaluate((el: HTMLElement, targetChecked: boolean) => {
		const input = el.tagName === "INPUT" ? el as HTMLInputElement
			: el.querySelector("input[type='checkbox']") as HTMLInputElement | null
		if (!input) {
			el.click()
			return
		}
		// Use the native property setter to bypass React's override
		const nativeSetter = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype, "checked"
		)?.set
		if (nativeSetter) {
			nativeSetter.call(input, targetChecked)
		} else {
			input.checked = targetChecked
		}
		// Fire events that React's synthetic event system listens for
		input.dispatchEvent(new Event("click", { bubbles: true }))
		input.dispatchEvent(new Event("input", { bubbles: true }))
		input.dispatchEvent(new Event("change", { bubbles: true }))
	}, checked)
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
	let resolvedSelector: ResolvedSelector | undefined

	try {
		switch (action.action) {
			case "click": {
				const locator = await resolveActionTarget(page, action, a11yTree)
				resolvedSelector = await extractSelectorInfo(
					page,
					action,
					a11yTree,
					locator,
				)
				await runWithNavigationHandling(page, () => locator.click())
				break
			}

			case "check": {
				const locator = await resolveActionTarget(page, action, a11yTree)
				resolvedSelector = await extractSelectorInfo(
					page,
					action,
					a11yTree,
					locator,
				)
				await checkCheckbox(page, locator, true)
				break
			}

			case "uncheck": {
				const locator = await resolveActionTarget(page, action, a11yTree)
				resolvedSelector = await extractSelectorInfo(
					page,
					action,
					a11yTree,
					locator,
				)
				await checkCheckbox(page, locator, false)
				break
			}

			case "type": {
				if (!action.value) {
					throw new Error("type action requires a value")
				}
				const locator = await resolveActionTarget(page, action, a11yTree)
				resolvedSelector = await extractSelectorInfo(
					page,
					action,
					a11yTree,
					locator,
				)
				// Click to focus, clear existing value, then type character by
				// character. pressSequentially dispatches real keydown/keypress/
				// keyup/input events per keystroke, which is required for
				// frameworks that rely on JS input events (React onChange, custom
				// validation, etc.). fill() bypasses these.
				await locator.click()
				await locator.fill("")
				await locator.pressSequentially(action.value, { delay: 30 })

				// Verify the value landed correctly. Async UI (search dropdowns,
				// autocomplete overlays) can steal focus or trigger re-renders
				// that swallow the last keystrokes. If the value drifted, re-focus
				// and type the missing suffix.
				const actual = await locator.inputValue().catch(() => "")
				if (actual !== action.value) {
					if (globals.debug) {
						console.log(`      [type] Value drifted: got "${actual}", expected "${action.value}" — correcting`)
					}
					await locator.click()
					if (action.value.startsWith(actual)) {
						// Only the tail is missing — append it
						await locator.pressSequentially(
							action.value.slice(actual.length),
							{ delay: 30 },
						)
					} else {
						// Value is garbled — clear and retype
						await locator.fill("")
						await locator.pressSequentially(action.value, { delay: 30 })
					}
				}
				break
			}

			case "select": {
				if (!action.value) {
					throw new Error("select action requires a value")
				}
				const locator = await resolveActionTarget(page, action, a11yTree)
				resolvedSelector = await extractSelectorInfo(
					page,
					action,
					a11yTree,
					locator,
				)
				await locator.selectOption({ label: action.value })
				break
			}

			case "autocomplete": {
				if (!action.value) {
					throw new Error("autocomplete action requires a value")
				}
				const locator = await resolveActionTarget(page, action, a11yTree)
				resolvedSelector = await extractSelectorInfo(
					page,
					action,
					a11yTree,
					locator,
				)

				if (globals.debug) {
					console.log(`      [autocomplete] Typing "${action.value}" into field (target: ${action.ref ?? action.text ?? "unknown"})`)
					if (action.option) {
						console.log(`      [autocomplete] Will select specific option: "${action.option}"`)
					} else {
						console.log(`      [autocomplete] Will select first suggestion`)
					}
				}

				// Click to focus, then type character by character to trigger autocomplete
				await locator.click()
				await locator.fill("")
				await locator.pressSequentially(action.value, { delay: 50 })

				if (globals.debug) {
					console.log(`      [autocomplete] Typed "${action.value}", waiting for suggestions...`)
				}

				// Wait for autocomplete suggestions to appear.
				// Try multiple common patterns: role=option, role=listbox children,
				// generic dropdown/suggestion containers.
				const suggestionPatterns = [
					{ name: "role=option", locator: page.locator("[role='option']") },
					{ name: "role=listbox children", locator: page.locator("[role='listbox'] > *") },
					{ name: "CSS class patterns", locator: page.locator(".autocomplete-results > *, .suggestions > *, .dropdown-menu > *") },
				]

				let suggestions: import("playwright").Locator | undefined
				let matchedPattern: string | undefined
				for (const pattern of suggestionPatterns) {
					try {
						await pattern.locator.first().waitFor({ state: "visible", timeout: 5000 })
						suggestions = pattern.locator
						matchedPattern = pattern.name
						break
					} catch {
						if (globals.debug) {
							console.log(`      [autocomplete] Pattern "${pattern.name}" — no match`)
						}
					}
				}

				if (!suggestions) {
					throw new Error(
						"Autocomplete suggestions did not appear after typing",
					)
				}

				const suggestionCount = await suggestions.count()
				if (globals.debug) {
					console.log(`      [autocomplete] Found ${String(suggestionCount)} suggestions via "${matchedPattern!}"`)
					// Log first few suggestion texts
					const previewCount = Math.min(suggestionCount, 5)
					for (let i = 0; i < previewCount; i++) {
						try {
							const text = await suggestions.nth(i).textContent()
							console.log(`      [autocomplete]   ${String(i + 1)}. ${text?.trim() ?? "(empty)"}`)
						} catch { /* skip */ }
					}
					if (suggestionCount > 5) {
						console.log(`      [autocomplete]   ... and ${String(suggestionCount - 5)} more`)
					}
				}

				// Select the target option
				if (action.option) {
					// Find by matching text
					const optionCandidates = [
						{ name: "filter by hasText", locator: suggestions.filter({ hasText: action.option }).first() },
						{ name: "getByRole option", locator: page.getByRole("option", { name: action.option }) },
						{ name: "getByText exact", locator: page.getByText(action.option, { exact: true }) },
						{ name: "getByText loose", locator: page.getByText(action.option) },
					]
					let clicked = false
					for (const candidate of optionCandidates) {
						try {
							if (await candidate.locator.isVisible()) {
								if (globals.debug) {
									console.log(`      [autocomplete] Clicking option "${action.option}" via ${candidate.name}`)
								}
								await candidate.locator.click()
								clicked = true
								break
							}
						} catch {
							if (globals.debug) {
								console.log(`      [autocomplete] Option strategy "${candidate.name}" — no match`)
							}
						}
					}
					if (!clicked) {
						throw new Error(
							`Autocomplete option "${action.option}" not found in suggestions`,
						)
					}
				} else {
					// Click the first visible suggestion
					if (globals.debug) {
						const firstText = await suggestions.first().textContent()
						console.log(`      [autocomplete] Clicking first suggestion: "${firstText?.trim() ?? "(empty)"}"`)
					}
					await suggestions.first().click()
				}

				if (globals.debug) {
					console.log(`      [autocomplete] Done`)
				}
				break
			}

			case "scroll": {
				if (action.ref) {
					const locator = await resolveLocator(page, a11yTree, action.ref)
					resolvedSelector = await extractSelectorInfo(
						page,
						action,
						a11yTree,
						locator,
					)
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
			resolvedSelector,
		}
	} catch (err) {
		return {
			success: false,
			duration: performance.now() - start,
			error: err instanceof Error ? err.message : String(err),
			resolvedSelector,
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
		assertion.type === "element_exists" ||
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
