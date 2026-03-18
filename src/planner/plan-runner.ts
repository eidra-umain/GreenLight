/**
 * Replays a cached heuristic plan directly via Playwright — no LLM calls.
 * For actions with stored selectors (click, type, select), builds locators
 * from the selector. For other actions, delegates to the regular executor.
 */

import type { Page, Locator } from "playwright"
import type { Action, MapState, StepResult, TestCaseResult } from "../reporter/types.js"
import type { HeuristicPlan, HeuristicSelector, HeuristicStep } from "./plan-types.js"
import type { MapAdapter } from "../map/types.js"
import { detectMap, captureMapState } from "../map/index.js"
import { executeAction, runWithNavigationHandling } from "../pilot/executor.js"
import { checkCheckbox } from "../pilot/checkbox.js"
import { extractQuotedText } from "../pilot/locator.js"
import { globals } from "../globals.js"

type AriaRole = Parameters<Page["getByRole"]>[0]

/** Build a Playwright locator from a stored heuristic selector. */
function buildLocator(page: Page, selector: HeuristicSelector, stepHint?: string) {
	if (selector.css) {
		return page.locator(selector.css)
	}
	if (selector.role) {
		// "text" is not a valid ARIA role — it comes from Playwright's a11y
		// snapshot for plain text nodes (e.g. radio cards inside radiogroups).
		// Resolve by text content instead, using the step hint if available.
		if (selector.role === "text" && selector.name) {
			if (stepHint) {
				return page.getByText(stepHint)
			}
			return page.getByText(selector.name)
		}
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
	mapAdapter?: MapAdapter | null,
): Promise<{ success: boolean; duration: number; error?: string }> {
	const start = performance.now()

	// Extract hint text from the step for text-node resolution
	const hintText = extractQuotedText(step.originalStep)
		?? (step.originalStep.replace(/^(?:click|select|check|type|press|scroll|navigate|wait|assert|verify)\s+(?:on\s+(?:the\s+)?)?/i, "").trim()
		|| step.originalStep)

	try {
		switch (step.action) {
			case "click": {
				if (!step.selector) throw new Error("click step requires a selector")
				const locator = buildLocator(page, step.selector, hintText)
				await runWithNavigationHandling(page, () => locator.click())
				break
			}

			case "type": {
				if (!step.value) throw new Error("type step requires a value")
				if (!step.selector) throw new Error("type step requires a selector")
				const locator = buildLocator(page, step.selector, hintText)
				await locator.fill(step.value)
				break
			}

			case "select": {
				if (!step.value) throw new Error("select step requires a value")
				if (!step.selector) throw new Error("select step requires a selector")
				const locator = buildLocator(page, step.selector, hintText)
				const tag = await locator.evaluate((el) => el.tagName).catch(() => "")
				if (tag === "SELECT") {
					await locator.selectOption({ label: step.value })
				} else {
					// Custom dropdown: click to open, find option in popup
					await locator.click()
					await page.waitForTimeout(500)
					let clicked = false
					// Search in menu/listbox containers first
					const popupSelectors = [
						"[role='menu']", "[role='listbox']",
						"[data-part='content']",
						"[data-state='open'][data-scope='menu']",
					]
					for (const sel of popupSelectors) {
						if (clicked) break
						try {
							const containers = page.locator(sel)
							const count = await containers.count()
							for (let i = 0; i < count && !clicked; i++) {
								const container = containers.nth(i)
								if (!await container.isVisible().catch(() => false)) continue
								const opt = container.getByText(step.value, { exact: true })
								if (await opt.first().isVisible().catch(() => false)) {
									await opt.first().click()
									clicked = true
								}
							}
						} catch { /* try next */ }
					}
					// Fallback: role-based page-wide
					if (!clicked) {
						const roles = ["menuitem", "menuitemradio", "option"] as const
						for (const role of roles) {
							try {
								const opt = page.getByRole(role, { name: step.value })
								if (await opt.first().isVisible().catch(() => false)) {
									await opt.first().click()
									clicked = true
									break
								}
							} catch { /* try next */ }
						}
					}
					if (!clicked) {
						throw new Error(`Could not find option "${step.value}" in custom dropdown`)
					}
				}
				break
			}

			case "autocomplete": {
				if (!step.value) throw new Error("autocomplete step requires a value")
				if (!step.selector) throw new Error("autocomplete step requires a selector")
				const locator = buildLocator(page, step.selector, hintText)
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

				let suggestions: Locator | undefined
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
				if (!step.selector) throw new Error("check step requires a selector")
				const locator = buildLocator(page, step.selector, hintText)
				await checkCheckbox(page, locator, true)
				break
			}

			case "uncheck": {
				if (!step.selector) throw new Error("uncheck step requires a selector")
				const locator = buildLocator(page, step.selector, hintText)
				await checkCheckbox(page, locator, false)
				break
			}

			case "remember": {
				const varName = step.rememberAs ?? step.value ?? ""
				const wantsNumber = /number|count|total|amount|qty|quantity|pris|antal|resultat/.test(
					varName.toLowerCase(),
				)
				let capturedText = ""
				if (step.selector) {
					const locator = buildLocator(page, step.selector, hintText)
					capturedText = (await locator.textContent() ?? "").trim()
					// If the variable name implies a number but the captured text
					// has none, the stored selector likely points to a nearby
					// element (e.g. a heading instead of the count). Fall back to
					// keyword search on the page.
					if (wantsNumber && !/\d/.test(capturedText)) {
						if (globals.debug) {
							console.log(`      [cached:remember] "${capturedText}" has no number, falling back to keyword search`)
						}
						capturedText = ""
					}
				}
				if (!capturedText) {
					// No selector stored — use innerText (preserves visual
					// line breaks) and search for text matching keywords
					const keywords = varName
						.replace(/_/g, " ")
						.split(" ")
						.filter((w) => w.length > 2)
					const innerText = await page.locator("body").innerText()
					// Split on newlines/tabs to get visual text segments
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
							"remember: no selector stored and could not find matching value on page",
						)
					}
					capturedText = best
				}
				if (globals.debug) {
					console.log(`      [cached:remember] Captured "${capturedText}" as "${varName}"`)
				}
				globals.valueStore.set(varName, capturedText)
				return { success: true, duration: performance.now() - start }
			}

			case "scroll": {
				if (step.selector) {
					const locator = buildLocator(page, step.selector, hintText)
					await locator.scrollIntoViewIfNeeded()
				} else {
					const delta = step.value === "up" ? -500 : 500
					await page.mouse.wheel(0, delta)
				}
				break
			}

			case "map_detect": {
				// Map detection is handled by the caller (runCachedPlan).
				// If we reach here, it means the caller already ran detection.
				return { success: true, duration: performance.now() - start }
			}

			default: {
				// navigate, press, wait, assert → delegate to regular executor
				const action: Action = {
					action: step.action,
					value: step.value,
					assertion: step.assertion,
				}
				// Compare asserts: override the assertion type so the executor
				// performs a live numeric comparison instead of an exact text match.
				// During discovery the LLM may have stored a contains_text with
				// a hardcoded value (e.g. "42 resultat"), but the cached run
				// must compare dynamically against the remembered value.
				if (step.compare) {
					action.compare = {
						variable: step.compare.variable,
						operator: step.compare.operator as Action["compare"] extends { operator: infer O } ? O : never,
						...(step.compare.literal !== undefined ? { literal: step.compare.literal } : {}),
					}
					action.assertion = { type: "compare", expected: step.originalStep }
				}
				if (step.selector) {
					// For compare asserts that need an element ref to read current value
					if (step.selector.role) {
						action.text = step.selector.name
					} else if (step.selector.css) {
						action.text = step.selector.css
					}
				}
				if (step.rememberAs) {
					action.rememberAs = step.rememberAs
				}
				// Pass map context for map_state assertions
				const mapContext: { adapter: MapAdapter; state?: MapState } | undefined = mapAdapter
					? { adapter: mapAdapter, state: undefined }
					: undefined
				if (mapContext && mapAdapter) {
					try {
						mapContext.state = await captureMapState(page, mapAdapter)
					} catch { /* map may not be present for this step */ }
				}
				const result = await executeAction(page, action, [], undefined, mapContext)
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
	options?: { waitForNetworkIdle?: () => Promise<void>; onStepComplete?: (result: StepResult) => void },
): Promise<TestCaseResult> {
	const startTime = performance.now()
	const stepResults: StepResult[] = []
	const recordStep = (result: StepResult) => {
		stepResults.push(result)
		options?.onStepComplete?.(result)
	}
	let drifted = false
	let mapAdapter: MapAdapter | null = null
	globals.valueStore.clear()

	for (const step of plan.steps) {
		const stepStart = performance.now()

		// Wait for async content to settle before interacting
		if (options?.waitForNetworkIdle) {
			await options.waitForNetworkIdle()
		}

		// Handle map detection step — find and attach to the map instance
		if (step.action === "map_detect") {
			try {
				mapAdapter = await detectMap(page)
				if (!mapAdapter) {
					drifted = true
					recordStep({
						step: step.originalStep,
						action: { action: "map_detect" },
						status: "failed",
						duration: performance.now() - stepStart,
						error: "Plan drift: No supported map library detected on the page.",
					})
					break
				}
				recordStep({
					step: step.originalStep,
					action: { action: "map_detect" },
					status: "passed",
					duration: performance.now() - stepStart,
				})
				continue
			} catch (err) {
				drifted = true
				recordStep({
					step: step.originalStep,
					action: { action: "map_detect" },
					status: "failed",
					duration: performance.now() - stepStart,
					error: `Plan drift: ${err instanceof Error ? err.message : String(err)}`,
				})
				break
			}
		}

		const result = await executeHeuristicStep(page, step, mapAdapter)

		// Wait for the page to stabilize after mutating actions
		// (click, type, select, etc.) so the next step sees a settled page.
		if (result.success && step.action !== "assert") {
			await page.waitForLoadState("domcontentloaded")
			if (options?.waitForNetworkIdle) {
				await options.waitForNetworkIdle()
			}
		}

		if (!result.success) {
			drifted = true
			recordStep({
				step: step.originalStep,
				action: {
					action: step.action,
					value: step.value,
					assertion: step.assertion,
				},
				status: "failed",
				duration: performance.now() - stepStart,
				error: `Plan drift: ${result.error ?? "unknown error"}`,
			})
			break
		}

		// Check URL path fingerprint for drift.
		// Skip for assert steps — they don't change the URL, and after a
		// navigation-triggering action the URL may have changed legitimately
		// before the assert runs. The fingerprint from discovery may reflect
		// a pre-navigation snapshot.
		const isAssert = step.action === "assert"
		// For navigation-triggering actions, wait briefly for the URL to
		// update — client-side routers (Next.js, React Router) may update
		// the URL via pushState slightly after the DOM settles.
		if (!isAssert && hasPathDrift(step.postStepFingerprint.url, page.url())) {
			try {
				const expectedPath = new URL(step.postStepFingerprint.url).pathname
				await page.waitForURL(`**${expectedPath}*`, { timeout: 5000 })
			} catch { /* URL didn't update — will be caught by drift check below */ }
		}
		const currentUrl = page.url()
		if (!isAssert && hasPathDrift(step.postStepFingerprint.url, currentUrl)) {
			drifted = true
			recordStep({
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

		recordStep({
			step: step.originalStep,
			action: {
				action: step.action,
				value: step.value,
				assertion: step.assertion,
			},
			status: "passed",
			duration: performance.now() - stepStart,
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
