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
 * Resolve an element ref to a Playwright locator using the node's role and name.
 */
export function resolveLocator(
	page: Page,
	nodes: A11yNode[],
	ref: string,
): Locator {
	const node = findNodeByRef(nodes, ref)
	if (!node) {
		throw new Error(`Element ref "${ref}" not found in accessibility tree`)
	}

	if (node.name) {
		return page.getByRole(node.role as Parameters<Page["getByRole"]>[0], {
			name: node.name,
		})
	}

	return page.getByRole(node.role as Parameters<Page["getByRole"]>[0])
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
				if (!action.ref) {
					throw new Error("click action requires a ref")
				}
				const locator = resolveLocator(page, a11yTree, action.ref)
				await locator.click()
				break
			}

			case "type": {
				if (!action.ref) {
					throw new Error("type action requires a ref")
				}
				if (!action.value) {
					throw new Error("type action requires a value")
				}
				const locator = resolveLocator(page, a11yTree, action.ref)
				await locator.fill(action.value)
				break
			}

			case "select": {
				if (!action.ref) {
					throw new Error("select action requires a ref")
				}
				if (!action.value) {
					throw new Error("select action requires a value")
				}
				const locator = resolveLocator(page, a11yTree, action.ref)
				await locator.selectOption({ label: action.value })
				break
			}

			case "scroll": {
				if (action.ref) {
					const locator = resolveLocator(page, a11yTree, action.ref)
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
				await page.keyboard.press(action.value)
				break
			}

			case "navigate": {
				if (!action.value) {
					throw new Error("navigate action requires a value")
				}
				const url = action.value.startsWith("/")
					? new URL(action.value, page.url()).href
					: action.value
				await page.goto(url)
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
 * Execute an assertion against the current page state.
 */
async function executeAssertion(
	page: Page,
	assertion: { type: string; expected: string },
): Promise<void> {
	switch (assertion.type) {
		case "contains_text": {
			const body = await page.locator("body").textContent()
			if (!body?.includes(assertion.expected)) {
				throw new Error(`Page does not contain text: "${assertion.expected}"`)
			}
			break
		}

		case "url_contains": {
			const url = page.url()
			if (!url.includes(assertion.expected)) {
				throw new Error(`URL "${url}" does not contain "${assertion.expected}"`)
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

		default:
			throw new Error(`Unknown assertion type: ${assertion.type}`)
	}
}
