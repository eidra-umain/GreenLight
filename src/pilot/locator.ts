/**
 * Locator resolution — translates a11y tree refs into Playwright locators.
 */

import type { Page, Locator } from "playwright"
import type { A11yNode, Action, ResolvedSelector } from "../reporter/types.js"

export type AriaRole = Parameters<Page["getByRole"]>[0]

/** All quote characters we recognise (straight + curly). */
const QUOTE_CHARS = `"'""''`
const QUOTE_RE = new RegExp(`[${QUOTE_CHARS}]([^${QUOTE_CHARS}]+)[${QUOTE_CHARS}]`)

/**
 * Extract the first quoted substring from text, handling straight and
 * curly quotes. Returns the inner text, or null if no quotes found.
 *
 * Shared across locator resolution and assertion keyword extraction
 * so quote handling is consistent everywhere.
 */
export function extractQuotedText(text: string): string | null {
	const match = QUOTE_RE.exec(text)
	return match ? match[1] : null
}

/**
 * Strip all quote characters from a string.
 */
export function stripQuotes(text: string): string {
	return text.replace(new RegExp(`[${QUOTE_CHARS}]`, "g"), "")
}

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

/**
 * Given a locator, return it if it matches exactly one element,
 * or return the first visible match if there are several.
 * Returns undefined if the locator matches nothing.
 */
export async function pickVisible(locator: Locator): Promise<Locator | undefined> {
	try {
		const count = await locator.count()
		if (count === 1) {
			// Verify the single match is actually visible
			if (await locator.isVisible()) return locator
			return undefined
		}
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

export function roleLocator(scope: Page | Locator, node: A11yNode): Locator {
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
	stepHint?: string,
): Promise<Locator> {
	const path = findNodePath(nodes, ref)
	if (!path || path.length === 0) {
		throw new Error(`Element ref "${ref}" not found in accessibility tree`)
	}

	const target = path[path.length - 1]
	const role = target.role as AriaRole

	// "text" is not a valid ARIA role — it comes from Playwright's a11y
	// snapshot for plain text nodes (e.g. radio cards rendered as text
	// inside a radiogroup). Resolve these by text content instead.
	const isNonAriaRole = target.role === "text"

	// Extract the meaningful text from the step hint. The hint is the full
	// step description (e.g. "click 'Hämta produkt i butik'") — extract
	// the quoted portion if present, or strip the action verb prefix.
	let hintText = stepHint
	if (hintText) {
		hintText = extractQuotedText(hintText)
			?? (hintText.replace(/^(?:click|select|check|type|press|scroll|navigate|wait|assert|verify)\s+(?:on\s+(?:the\s+)?)?/i, "").trim()
			|| hintText)
	}

	// Build candidates list, best to worst
	const candidates: Locator[] = []

	if (isNonAriaRole && target.name) {
		// For non-ARIA roles (e.g. "text" nodes inside radiogroups), use
		// text-based resolution. Try the full a11y name first, then fall
		// back to the step hint text (the quoted text from the step
		// instruction, e.g. "Hämta produkt i butik") for a partial match.
		candidates.push(page.getByText(target.name, { exact: true }))
		candidates.push(page.getByText(target.name))
		if (hintText) {
			candidates.push(page.getByText(hintText, { exact: true }))
			candidates.push(page.getByText(hintText))
		}
	} else {
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
	}

	// Try each candidate: return the first that matches exactly one element,
	// or the first visible element when there are multiple matches.
	for (const locator of candidates) {
		const match = await pickVisible(locator)
		if (match) return match
	}

	// Last resort — return the basic locator and let Playwright handle errors.
	// For non-ARIA roles (text nodes), prefer the step hint over the full
	// concatenated a11y name which often doesn't match the DOM text.
	if (isNonAriaRole) {
		return page.getByText(hintText ?? target.name)
	}
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
export async function resolveByText(page: Page, text: string): Promise<Locator> {
	const candidates: Locator[] = [
		// Exact text match — try common interactive roles first, then any element
		page.getByRole("link", { name: text, exact: true }),
		page.getByRole("button", { name: text, exact: true }),
		page.getByRole("radio", { name: text, exact: true }),
		page.getByRole("checkbox", { name: text, exact: true }),
		page.getByRole("tab", { name: text, exact: true }),
		page.getByText(text, { exact: true }),
		// Loose match
		page.getByRole("link", { name: text }),
		page.getByRole("button", { name: text }),
		page.getByRole("radio", { name: text }),
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
export async function resolveActionTarget(
	page: Page,
	action: Action,
	a11yTree: A11yNode[],
	stepHint?: string,
): Promise<Locator> {
	if (action.ref) {
		return resolveLocator(page, a11yTree, action.ref, stepHint)
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
export async function extractCssSelector(
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
					const cur = current
					const sameTag = Array.from(parent.children).filter(
						(c) => c.tagName === cur.tagName,
					)
					if (sameTag.length > 1) {
						sel += `:nth-of-type(${String(sameTag.indexOf(current) + 1)})`
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
export async function extractSelectorInfo(
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
