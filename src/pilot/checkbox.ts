// GreenLight E2E Testing
// Copyright (c) 2026 Umain AB Sweden
//
// This program is free software: you can redistribute it and/or
// modify it under the terms of the GNU General Public License as
// published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

/**
 * Checkbox interaction — handles check/uncheck across different UI frameworks.
 */

import type { Page, Locator } from "playwright"
import { globals } from "../globals.js"

/**
 * Check or uncheck a checkbox using multiple strategies.
 * Modern frameworks (React, Vue, etc.) use synthetic event systems that
 * don't respond to native DOM property changes. We try multiple approaches
 * in order until the checkbox state actually changes.
 */
export async function checkCheckbox(
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
			const input: HTMLInputElement | null = el.tagName === "INPUT"
				? el as HTMLInputElement
				: el.querySelector("input[type='checkbox']")
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
		const input: HTMLInputElement | null = el.tagName === "INPUT"
			? el as HTMLInputElement
			: el.querySelector<HTMLInputElement>("input[type='checkbox']")
		if (!input) {
			el.click()
			return
		}
		// Use the native property setter to bypass React's override
		const descriptor = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype, "checked"
		)
		if (descriptor?.set) {
			descriptor.set.call(input, targetChecked)
		} else {
			input.checked = targetChecked
		}
		// Fire events that React's synthetic event system listens for
		input.dispatchEvent(new Event("click", { bubbles: true }))
		input.dispatchEvent(new Event("input", { bubbles: true }))
		input.dispatchEvent(new Event("change", { bubbles: true }))
	}, checked)
}
