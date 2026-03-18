/**
 * Runtime condition evaluators for conditional steps.
 *
 * Each evaluator checks a condition against the live page state and returns
 * a boolean. They are non-throwing: false means "condition not met", not an error.
 */

import type { Page } from "playwright"

/** A condition to evaluate at runtime. */
export interface Condition {
	type: "visible" | "contains" | "url"
	target: string
}

/** Evaluate a condition against the live page. Returns true if the condition is met. */
export async function evaluateCondition(page: Page, condition: Condition): Promise<boolean> {
	switch (condition.type) {
		case "visible":
			return evaluateVisible(page, condition.target)
		case "contains":
			return evaluateContains(page, condition.target)
		case "url":
			return evaluateUrl(page, condition.target)
	}
}

/**
 * Check whether an element matching the target description is visible on the page.
 * Tries multiple locator strategies since the target may describe a button, link,
 * form field, or plain text. Uses a short timeout (2s) to allow for async rendering.
 */
async function evaluateVisible(page: Page, target: string): Promise<boolean> {
	// Extract quoted text if present: 'Skip' → Skip
	const quoted = /^["'](.+)["']$/.exec(target.trim())
	const text = quoted ? quoted[1] : target

	const locators = [
		// Exact text match (buttons, links, headings, etc.)
		page.getByText(text, { exact: true }),
		// Fuzzy text match
		page.getByText(text),
		// Interactive elements by role + name
		page.getByRole("button", { name: text }),
		page.getByRole("link", { name: text }),
		// Form fields by label or placeholder
		page.getByLabel(text),
		page.getByPlaceholder(text),
	]

	for (const locator of locators) {
		try {
			if (await locator.first().isVisible()) {
				return true
			}
		} catch {
			// locator didn't match, try next
		}
	}

	// Final attempt: wait briefly in case the element is still rendering
	try {
		await page.getByText(text).first().waitFor({ state: "visible", timeout: 2000 })
		return true
	} catch {
		return false
	}
}

/** Check whether the page body contains the given text (case-insensitive). */
async function evaluateContains(page: Page, target: string): Promise<boolean> {
	try {
		const body = await page.locator("body").textContent()
		return body?.toLowerCase().includes(target.toLowerCase()) ?? false
	} catch {
		return false
	}
}

/** Check whether the current URL contains the given string. */
async function evaluateUrl(page: Page, target: string): Promise<boolean> {
	try {
		return page.url().includes(target)
	} catch {
		return false
	}
}
