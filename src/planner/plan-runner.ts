/**
 * Replays a cached heuristic plan directly via Playwright — no LLM calls.
 * For actions with stored selectors (click, type, select), builds locators
 * from the selector. For other actions, delegates to the regular executor.
 */

import type { Page } from "playwright"
import type { Action, StepResult, TestCaseResult } from "../reporter/types.js"
import type { HeuristicPlan, HeuristicSelector, HeuristicStep } from "./plan-types.js"
import { executeAction, runWithNavigationHandling } from "../pilot/executor.js"
import { globals } from "../globals.js"

type AriaRole = Parameters<Page["getByRole"]>[0]

/** Build a Playwright locator from a stored heuristic selector. */
function buildLocator(page: Page, selector: HeuristicSelector) {
	if (selector.css) {
		return page.locator(selector.css)
	}
	if (selector.role) {
		const role = selector.role as AriaRole
		let locator = selector.name
			? page.getByRole(role, { name: selector.name })
			: page.getByRole(role)
		// When multiple elements match the same role+name, use the recorded index
		if (selector.nth != null) {
			locator = locator.nth(selector.nth)
		}
		return locator
	}
	throw new Error("Heuristic selector has neither role nor css")
}

/**
 * Execute a single heuristic step.
 * Actions with selectors (click, type, select) use stored selectors directly.
 * Other actions delegate to the regular executor.
 */
async function executeHeuristicStep(
	page: Page,
	step: HeuristicStep,
): Promise<{ success: boolean; duration: number; error?: string }> {
	const start = performance.now()

	try {
		switch (step.action) {
			case "click": {
				const locator = buildLocator(page, step.selector!)
				await runWithNavigationHandling(page, () => locator.click())
				break
			}

			case "type": {
				if (!step.value) throw new Error("type step requires a value")
				const locator = buildLocator(page, step.selector!)
				await locator.fill(step.value)
				break
			}

			case "select": {
				if (!step.value) throw new Error("select step requires a value")
				const locator = buildLocator(page, step.selector!)
				await locator.selectOption({ label: step.value })
				break
			}

			case "autocomplete": {
				if (!step.value) throw new Error("autocomplete step requires a value")
				const locator = buildLocator(page, step.selector!)
				await locator.click()
				await locator.fill("")
				await locator.pressSequentially(step.value, { delay: 50 })

				if (globals.debug) {
					console.log(`      [cached:autocomplete] Typed "${step.value}", waiting for suggestions...`)
				}

				// Wait for suggestions to appear
				const suggestionPatterns = [
					page.locator("[role='option']"),
					page.locator("[role='listbox'] > *"),
					page.locator(".autocomplete-results > *, .suggestions > *, .dropdown-menu > *"),
				]

				let suggestions: import("playwright").Locator | undefined
				for (const loc of suggestionPatterns) {
					try {
						await loc.first().waitFor({ state: "visible", timeout: 5000 })
						suggestions = loc
						break
					} catch { /* try next */ }
				}

				if (!suggestions) {
					throw new Error("Autocomplete suggestions did not appear")
				}

				if (step.option) {
					const candidates = [
						suggestions.filter({ hasText: step.option }).first(),
						page.getByRole("option", { name: step.option }),
						page.getByText(step.option, { exact: true }),
						page.getByText(step.option),
					]
					let clicked = false
					for (const opt of candidates) {
						try {
							if (await opt.isVisible()) {
								await opt.click()
								clicked = true
								break
							}
						} catch { /* try next */ }
					}
					if (!clicked) {
						throw new Error(`Autocomplete option "${step.option}" not found`)
					}
				} else {
					await suggestions.first().click()
				}
				break
			}

			case "check": {
				const locator = buildLocator(page, step.selector!)
				// Delegate to the executor's checkCheckbox via executeAction
				const action: Action = { action: "check", ref: "_dummy" }
				// We can't use executeAction easily here, so replicate the fallback
				try {
					await locator.check({ timeout: 3000 })
				} catch {
					try {
						const labelClicked = await locator.evaluate((el: HTMLElement) => {
							let input: HTMLInputElement | null = null
							if (el.tagName === "INPUT") input = el as HTMLInputElement
							else input = el.querySelector("input[type='checkbox']")
							if (!input) return false
							if (input.id) {
								const label = document.querySelector(`label[for="${input.id}"]`)
								if (label) { (label as HTMLElement).click(); return true }
							}
							const label = input.closest("label")
							if (label) { label.click(); return true }
							return false
						})
						if (!labelClicked) {
							await locator.click({ force: true, timeout: 2000 })
						}
					} catch {
						await locator.evaluate((el: HTMLElement) => {
							const input = el.tagName === "INPUT" ? el as HTMLInputElement
								: el.querySelector("input[type='checkbox']") as HTMLInputElement | null
							if (input && !input.checked) {
								const nativeSetter = Object.getOwnPropertyDescriptor(
									HTMLInputElement.prototype, "checked"
								)?.set
								if (nativeSetter) nativeSetter.call(input, true)
								else input.checked = true
								input.dispatchEvent(new Event("click", { bubbles: true }))
								input.dispatchEvent(new Event("input", { bubbles: true }))
								input.dispatchEvent(new Event("change", { bubbles: true }))
							} else if (!input) {
								el.click()
							}
						})
					}
				}
				break
			}

			case "uncheck": {
				const locator = buildLocator(page, step.selector!)
				try {
					await locator.uncheck({ timeout: 3000 })
				} catch {
					await locator.click({ force: true, timeout: 2000 }).catch(() =>
						locator.dispatchEvent("click")
					)
				}
				break
			}

			case "scroll": {
				if (step.selector) {
					const locator = buildLocator(page, step.selector)
					await locator.scrollIntoViewIfNeeded()
				} else {
					const delta = step.value === "up" ? -500 : 500
					await page.mouse.wheel(0, delta)
				}
				break
			}

			default: {
				// navigate, press, wait, assert → delegate to regular executor
				const action: Action = {
					action: step.action,
					value: step.value,
					assertion: step.assertion,
				}
				const result = await executeAction(page, action, [])
				return {
					success: result.success,
					duration: performance.now() - start,
					error: result.error,
				}
			}
		}

		return { success: true, duration: performance.now() - start }
	} catch (err) {
		return {
			success: false,
			duration: performance.now() - start,
			error: err instanceof Error ? err.message : String(err),
		}
	}
}

/** Check if a URL path drift occurred (ignoring query params). */
function hasPathDrift(expectedUrl: string, actualUrl: string): boolean {
	try {
		const expectedPath = new URL(expectedUrl).pathname
		const actualPath = new URL(actualUrl).pathname
		return expectedPath !== actualPath
	} catch {
		// If URL parsing fails, compare as strings
		return expectedUrl !== actualUrl
	}
}

/**
 * Replay a cached heuristic plan against the browser.
 * Returns a TestCaseResult with mode "cached" and a drifted flag.
 */
export async function runCachedPlan(
	page: Page,
	plan: HeuristicPlan,
	testName: string,
	options?: { waitForNetworkIdle?: () => Promise<void> },
): Promise<TestCaseResult> {
	const startTime = performance.now()
	const stepResults: StepResult[] = []
	let drifted = false

	for (const step of plan.steps) {
		const stepStart = performance.now()

		// Wait for async content to settle before interacting
		if (options?.waitForNetworkIdle) {
			await options.waitForNetworkIdle()
		}

		const result = await executeHeuristicStep(page, step)

		if (!result.success) {
			drifted = true
			stepResults.push({
				step: step.originalStep,
				action: {
					action: step.action,
					value: step.value,
					assertion: step.assertion,
				},
				status: "failed",
				duration: performance.now() - stepStart,
				error: `Plan drift: ${result.error}`,
			})
			break
		}

		// Check URL path fingerprint for drift.
		// Skip for assert steps — they don't change the URL, and after a
		// navigation-triggering action the URL may have changed legitimately
		// before the assert runs. The fingerprint from discovery may reflect
		// a pre-navigation snapshot.
		const currentUrl = page.url()
		const isAssert = step.action === "assert"
		if (!isAssert && hasPathDrift(step.postStepFingerprint.url, currentUrl)) {
			drifted = true
			stepResults.push({
				step: step.originalStep,
				action: {
					action: step.action,
					value: step.value,
					assertion: step.assertion,
				},
				status: "failed",
				duration: performance.now() - stepStart,
				error: `Plan drift: expected URL path "${new URL(step.postStepFingerprint.url).pathname}" but got "${new URL(currentUrl).pathname}"`,
			})
			break
		}

		// Capture post-action screenshot for reporting
		let screenshot: string | undefined
		try {
			const buf = await page.screenshot({ type: "png" })
			screenshot = buf.toString("base64")
		} catch {
			// Screenshot failed — continue without it
		}

		stepResults.push({
			step: step.originalStep,
			action: {
				action: step.action,
				value: step.value,
				assertion: step.assertion,
			},
			status: "passed",
			duration: performance.now() - stepStart,
			screenshot,
		})
	}

	const allPassed = stepResults.every((s) => s.status === "passed")
	const status =
		allPassed && stepResults.length === plan.steps.length
			? "passed"
			: "failed"

	return {
		name: testName,
		status,
		steps: stepResults,
		duration: performance.now() - startTime,
		mode: "cached",
		drifted,
	}
}
