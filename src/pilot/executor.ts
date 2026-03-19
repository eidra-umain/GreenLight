/**
 * Action executor — translates LLM Action objects into Playwright browser calls.
 */

import type { Page, Locator } from "playwright"
import type {
	Action,
	A11yNode,
	ExecutionResult,
	MapState,
	ResolvedSelector,
} from "../reporter/types.js"
import type { MapAdapter } from "../map/types.js"
import Fuse from "fuse.js"
import { globals } from "../globals.js"

import {
	resolveLocator,
	resolveActionTarget,
	extractSelectorInfo,
	findNodeByRef,
} from "./locator.js"
import { checkCheckbox } from "./checkbox.js"
import { executeAssertion } from "./assertions.js"


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
 * Flatten an a11y node tree into a flat array.
 */
function flattenNodes(nodes: A11yNode[]): A11yNode[] {
	const result: A11yNode[] = []
	function walk(list: A11yNode[]): void {
		for (const node of list) {
			result.push(node)
			if (node.children) walk(node.children)
		}
	}
	walk(nodes)
	return result
}

/**
 * Search the enriched a11y tree for a value matching a query string.
 * Uses Fuse.js fuzzy matching against node name, placeholder, visibleText,
 * and value. When the best match is an input with a value, returns the
 * value (what was typed) rather than the label.
 *
 * Used as a fallback when the LLM returns a remember action without
 * specifying a target element.
 */
function findValueInTree(nodes: A11yNode[], keywords: string[]): string {
	const flat = flattenNodes(nodes).filter((n) => !n.ref.startsWith("_"))
	if (flat.length === 0) return ""

	const query = keywords.join(" ")

	const fuse = new Fuse(flat, {
		keys: [
			{ name: "name", weight: 2 },
			{ name: "placeholder", weight: 1.5 },
			{ name: "visibleText", weight: 1 },
			{ name: "value", weight: 0.5 },
		],
		threshold: 0.4,
		includeScore: true,
	})

	const results = fuse.search(query)

	if (globals.debug && results.length > 0) {
		console.log(`      [remember] Fuse.js top matches for "${query}":`)
		for (const r of results.slice(0, 3)) {
			console.log(`        - [${r.item.ref}] "${r.item.name}" value="${r.item.value ?? ""}" (score: ${String(r.score?.toFixed(3))})`)
		}
	}

	if (results.length > 0) {
		const best = results[0].item
		// Prefer the input value (what was typed) over the label
		if (best.value) return best.value
		if (best.visibleText) return best.visibleText
		return best.name
	}

	// No fuzzy match — return the first non-empty value field
	for (const node of flat) {
		if (node.value) return node.value
	}

	return ""
}

/**
 * Execute a single Action against the browser page.
 */
export async function executeAction(
	page: Page,
	action: Action,
	a11yTree: A11yNode[],
	_valueStore?: Map<string, string>,
	mapContext?: { state?: MapState; adapter?: MapAdapter },
	stepHint?: string,
): Promise<ExecutionResult> {
	const start = performance.now()
	let rememberedValue: string | undefined
	let resolvedSelector: ResolvedSelector | undefined

	try {
		switch (action.action) {
			case "click": {
				const locator = await resolveActionTarget(page, action, a11yTree, stepHint)
				resolvedSelector = await extractSelectorInfo(
					page,
					action,
					a11yTree,
					locator,
				)
				// Wait for the element to be visible and stable before clicking.
				// Menus and dropdowns may still be animating when the step starts.
				await locator.waitFor({ state: "visible", timeout: 5000 })
				// Fail fast if the target is a disabled button — don't wait 30s
				// for Playwright's built-in enabled check to time out.
				const isDisabled = await locator.isDisabled().catch(() => false)
				if (isDisabled) {
					const label = (await locator.textContent().catch(() => "unknown")) ?? "unknown"
					throw new Error(`Cannot click disabled element "${label.trim()}"`)
				}
				await runWithNavigationHandling(page, () => locator.click())
				break
			}

			case "check": {
				const locator = await resolveActionTarget(page, action, a11yTree, stepHint)
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
				const locator = await resolveActionTarget(page, action, a11yTree, stepHint)
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
				const locator = await resolveActionTarget(page, action, a11yTree, stepHint)
				resolvedSelector = await extractSelectorInfo(
					page,
					action,
					a11yTree,
					locator,
				)

				// Detect the element type to choose the right input strategy.
				// MUI spinbuttons (contentEditable sections) and native date
				// inputs need fill() instead of char-by-char typing.
				const ariaRole = await locator.getAttribute("role").catch(() => null)
				const inputType = await locator.getAttribute("type").catch(() => null)
				// Also check the a11y tree node's role (more reliable than DOM
				// attribute for elements resolved by ref).
				const a11yRole = action.ref ? findNodeByRef(a11yTree, action.ref)?.role : null
				const isSpinbutton = ariaRole === "spinbutton" || a11yRole === "spinbutton"
				const isDateInput = inputType === "date" || inputType === "datetime-local" || inputType === "time"

				if (isSpinbutton || isDateInput) {
					// Spinbuttons (MUI date picker sections) and native date
					// inputs: click to focus, then use fill() which sets the
					// value programmatically — char-by-char doesn't work on
					// contentEditable spinbuttons or formatted date inputs.
					await locator.click({ force: true })
					try {
						await locator.fill(action.value)
					} catch {
						// fill() may fail on contentEditable — fall back to
						// select-all + type which works on some implementations
						const selectAll = process.platform === "darwin" ? "Meta+a" : "Control+a"
						await page.keyboard.press(selectAll)
						await page.keyboard.type(action.value, { delay: 30 })
					}
					if (globals.debug) {
						console.log(`      [type] Used fill() for ${isSpinbutton ? "spinbutton" : "date input"}`)
					}
				} else {
					// Regular inputs: use real keypresses — click to focus,
					// select-all + delete to clear, then type char by char.
					// This looks like a real user and triggers all JS event
					// handlers (React onChange, custom validation, etc.).
					// Use force:true — inputs often have decorative overlays.
					await locator.click({ force: true })
					const selectAll = process.platform === "darwin" ? "Meta+a" : "Control+a"
					await page.keyboard.press(selectAll)
					await page.keyboard.press("Backspace")
					await page.keyboard.type(action.value, { delay: 30 })

					// Verify the value landed correctly. Use evaluate on the
					// active element to avoid locator actionability timeouts.
					const actual = await page.evaluate(
						() => {
							const el = document.activeElement as HTMLInputElement | null
							return el?.value ?? ""
						},
					).catch(() => "")
					if (actual !== action.value) {
						if (globals.debug) {
							console.log(`      [type] Value drifted: got "${actual}", expected "${action.value}" — correcting`)
						}
						await page.keyboard.press(selectAll)
						await page.keyboard.press("Backspace")
						await page.keyboard.type(action.value, { delay: 30 })
					}
				}
				break
			}

			case "select": {
				if (!action.value) {
					throw new Error("select action requires a value")
				}
				const locator = await resolveActionTarget(page, action, a11yTree, stepHint)
				resolvedSelector = await extractSelectorInfo(
					page,
					action,
					a11yTree,
					locator,
				)
				// Try native <select> first; if the element is a custom dropdown
				// (button/div with aria-haspopup), click to open it then click
				// the option by text.
				const tagName = await locator.evaluate((el) => el.tagName).catch(() => "")
				if (tagName === "SELECT") {
					await locator.selectOption({ label: action.value })
				} else {
					if (globals.debug) {
						console.log(`      [select] Element is not a <select>, using click-to-open strategy`)
					}
					// Click to open the dropdown
					await locator.click()

					// After clicking the trigger, wait a moment for the popup
					// to render, then find the option.
					await page.waitForTimeout(500)

					if (globals.debug) {
						try {
							const menuId = await locator.evaluate((el) =>
								el.getAttribute("aria-controls") ??
								el.getAttribute("data-controls") ?? ""
							)
							console.log(`      [select] Trigger aria-controls="${menuId}"`)
							// Dump all potential popup containers on the page
							const selectors = [
								"[role='menu']", "[role='listbox']",
								"[data-part='content']", "[data-state='open']",
								"[data-scope='menu']", "[aria-haspopup]",
							]
							for (const sel of selectors) {
								const count = await page.locator(sel).count().catch(() => 0)
								if (count > 0) {
									const visible = await page.locator(sel).first().isVisible().catch(() => false)
									console.log(`      [select] ${sel}: ${String(count)} found, first visible=${String(visible)}`)
								}
							}
						} catch { /* skip */ }
					}

					// Strategy 1: Find menu container via aria-controls and
					// search within it (safe — scoped to the popup).
					let clicked = false
					try {
						const menuId = await locator.evaluate((el) =>
							el.getAttribute("aria-controls") ??
							el.getAttribute("data-controls") ?? ""
						)
						if (menuId) {
							const menu = page.locator(`#${CSS.escape(menuId)}`)
							if (await menu.isVisible().catch(() => false)) {
								if (globals.debug) {
									console.log(`      [select] Found menu container: #${menuId}`)
								}
								const opt = menu.getByText(action.value, { exact: true })
								if (await opt.first().isVisible().catch(() => false)) {
									await opt.first().click()
									clicked = true
								} else {
									// Try loose match within menu
									const loose = menu.getByText(action.value)
									if (await loose.first().isVisible().catch(() => false)) {
										await loose.first().click()
										clicked = true
									}
								}
							}
						}
					} catch { /* try next strategy */ }

					// Strategy 2: Search all visible popup-like containers
					if (!clicked) {
						const popupSelectors = [
							"[role='menu']",
							"[role='listbox']",
							"[data-part='content']",
							"[data-state='open'][data-scope='menu']",
							"[data-radix-popper-content-wrapper]",
						]
						for (const sel of popupSelectors) {
							try {
								const containers = page.locator(sel)
								const count = await containers.count()
								for (let i = 0; i < count && !clicked; i++) {
									const container = containers.nth(i)
									if (!await container.isVisible().catch(() => false)) continue
									const opt = container.getByText(action.value, { exact: true })
									if (await opt.first().isVisible().catch(() => false)) {
										if (globals.debug) {
											console.log(`      [select] Found option in ${sel} container`)
										}
										await opt.first().click()
										clicked = true
									}
								}
							} catch { /* try next */ }
							if (clicked) break
						}
					}

					// Strategy 3: Role-based page-wide (menuitem/option only)
					if (!clicked) {
						const roleCandidates = [
							page.getByRole("menuitem", { name: action.value }),
							page.getByRole("menuitemradio", { name: action.value }),
							page.getByRole("option", { name: action.value }),
						]
						for (const opt of roleCandidates) {
							try {
								if (await opt.first().isVisible().catch(() => false)) {
									if (globals.debug) {
										console.log(`      [select] Found option via page-wide role search`)
									}
									await opt.first().click()
									clicked = true
									break
								}
							} catch { /* try next */ }
						}
					}

					if (!clicked) {
						throw new Error(
							`Could not find option "${action.value}" in custom dropdown`,
						)
					}
				}
				break
			}

			case "autocomplete": {
				if (!action.value) {
					throw new Error("autocomplete action requires a value")
				}
				const locator = await resolveActionTarget(page, action, a11yTree, stepHint)
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

				// Click to focus, clear, then type character by character to trigger autocomplete
				await locator.click({ force: true })
				const acSelectAll = process.platform === "darwin" ? "Meta+a" : "Control+a"
				await page.keyboard.press(acSelectAll)
				await page.keyboard.press("Backspace")
				await page.keyboard.type(action.value, { delay: 50 })

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

				let suggestions: Locator | undefined
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
					console.log(`      [autocomplete] Found ${String(suggestionCount)} suggestions via "${matchedPattern ?? "unknown"}"`)
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

			case "remember": {
				let capturedText: string
				if (action.ref || action.text) {
					const locator = await resolveActionTarget(page, action, a11yTree, stepHint)
					resolvedSelector = await extractSelectorInfo(
						page,
						action,
						a11yTree,
						locator,
					)
					// Try inputValue() first (for inputs/textareas), fall back to textContent
					capturedText = (await locator.inputValue().catch(() => null) ?? await locator.textContent() ?? "").trim()

					// If the variable name or step implies we need a number but
					// the captured text has none, the LLM likely picked the wrong
					// element. Fall back to keyword search in the a11y tree.
					const wantsNumber = /number|count|total|amount|qty|quantity|pris|antal|resultat/.test(
						(action.rememberAs ?? "").toLowerCase(),
					)
					if (wantsNumber && !/\d/.test(capturedText)) {
						if (globals.debug) {
							console.log(`      [remember] Captured "${capturedText}" but expected a number — falling back to keyword search`)
						}
						const keywords = (action.rememberAs ?? "")
							.replace(/_/g, " ")
							.split(" ")
							.filter((w) => w.length > 2)
						const fallback = findValueInTree(a11yTree, keywords)
						if (fallback) {
							capturedText = fallback
							if (globals.debug) {
								console.log(`      [remember] Keyword search found: "${capturedText}"`)
							}
						}
					}
				} else {
					// LLM didn't specify a target element. Search the a11y tree
					// for nodes whose text contains a number and matches keywords
					// from the step description (the variable name or step text).
					if (globals.debug) {
						console.log(`      [remember] No ref/text target, searching a11y tree for matching value`)
					}
					const keywords = (action.rememberAs ?? "")
						.replace(/_/g, " ")
						.split(" ")
						.filter((w) => w.length > 2)
					capturedText = findValueInTree(a11yTree, keywords)
					if (!capturedText) {
						throw new Error(
							`remember action: LLM returned no element target and could not find a matching value in the page`,
						)
					}
					if (globals.debug) {
						console.log(`      [remember] Found by keyword search: "${capturedText}"`)
					}
				}
				if (globals.debug) {
					const preview = capturedText.length > 80
						? capturedText.slice(0, 80) + "..."
						: capturedText
					console.log(`      [remember] Captured "${preview}" as "${action.rememberAs ?? ""}"`)
				}
				rememberedValue = capturedText
				break
			}

			case "assert": {
				if (!action.assertion) {
					throw new Error("assert action requires an assertion")
				}
				await executeAssertion(page, action, a11yTree, mapContext)
				break
			}

			default:
				throw new Error(`Unknown action: ${action.action}`)
		}

		return {
			success: true,
			duration: performance.now() - start,
			resolvedSelector,
			rememberedValue,
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
