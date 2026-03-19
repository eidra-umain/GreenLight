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
 * Form field capture and formatting for Playwright pages.
 */

import type { Page } from "playwright"

/** Metadata about a single form field, extracted from the DOM. */
export interface FormFieldInfo {
	/** The element ref from the a11y tree, if matched. */
	ref?: string
	/** The <label> text associated with this field. */
	label?: string
	/** The placeholder attribute value. */
	placeholder?: string
	/** The input type (text, email, tel, number, url, etc.). */
	inputType: string
	/** The tag name (input, textarea, select). */
	tag: string
	/** Whether the field is required. */
	required: boolean
	/** For select elements: the available option labels. */
	options?: string[]
	/** Whether this field is an autocomplete/typeahead/combobox that shows suggestions as you type. */
	autocomplete?: boolean
}

/**
 * Capture metadata about all visible form fields on the page.
 * Extracts label, placeholder, input type, required status, and select options
 * directly from the DOM — information not available in the a11y tree.
 */
export async function captureFormFields(page: Page): Promise<FormFieldInfo[]> {
	return page.evaluate(() => {
		const fields: {
			label?: string
			placeholder?: string
			inputType: string
			tag: string
			required: boolean
			options?: string[]
			autocomplete?: boolean
		}[] = []

		const inputs = document.querySelectorAll(
			"input, textarea, select",
		)

		for (const el of inputs) {
			// Skip hidden inputs and submit buttons
			if (el instanceof HTMLInputElement) {
				if (el.type === "hidden" || el.type === "submit" || el.type === "button") continue
			}

			// Skip invisible elements
			const style = window.getComputedStyle(el)
			if (style.display === "none" || style.visibility === "hidden") continue

			// Find label: explicit <label for="id">, wrapping <label>, or aria-label
			let label: string | undefined
			if (el.id) {
				const labelEl = document.querySelector(`label[for="${el.id}"]`)
				if (labelEl) label = labelEl.textContent.trim() || undefined
			}
			if (!label) {
				const labelEl = el.closest("label")
				if (labelEl) {
					// Get label text excluding the input's own text
					const clone = labelEl.cloneNode(true) as HTMLElement
					clone.querySelectorAll("input, textarea, select").forEach((c) => { c.remove() })
					label = clone.textContent.trim() || undefined
				}
			}
			if (!label) {
				const ariaLabel = el.getAttribute("aria-label")
				if (ariaLabel) {
					label = ariaLabel
				}
			}
			if (!label) {
				const ariaLabelledBy = el.getAttribute("aria-labelledby")
				if (ariaLabelledBy) {
					const labelledBy = document.getElementById(ariaLabelledBy)
					if (labelledBy) label = labelledBy.textContent.trim() || undefined
				}
			}

			// Detect autocomplete/typeahead/combobox patterns
			let autocomplete = false
			const role = el.getAttribute("role")
			const ariaAuto = el.getAttribute("aria-autocomplete")
			const ariaExpanded = el.hasAttribute("aria-expanded")
			const ariaOwns = el.getAttribute("aria-owns") ?? el.getAttribute("aria-controls")
			const htmlAutocomplete = el.getAttribute("autocomplete")

			// Explicit ARIA combobox or autocomplete
			if (role === "combobox" || ariaAuto === "list" || ariaAuto === "both") {
				autocomplete = true
			}
			// Has aria-expanded (toggle pattern) or aria-owns/controls a listbox
			if (ariaExpanded && ariaOwns) {
				autocomplete = true
			}
			// Parent or wrapper has combobox role
			if (el.closest("[role='combobox']")) {
				autocomplete = true
			}
			// Adjacent or nearby listbox/datalist
			if (el.getAttribute("list")) {
				autocomplete = true // HTML5 <datalist>
			}
			// Common CSS class patterns for autocomplete widgets
			const classes = el.className + " " + (el.closest("[class]")?.className ?? "")
			if (/autocomplete|typeahead|combobox|autosuggest|searchbox/i.test(classes)) {
				autocomplete = true
			}
			// Browser autocomplete="off" often indicates a custom autocomplete widget
			// (the site disables native autocomplete because it has its own)
			if (htmlAutocomplete === "off" && el instanceof HTMLInputElement && el.type === "text") {
				// Only flag as autocomplete if there are other hints (class patterns, nearby listboxes)
				const parent = el.parentElement
				if (parent && (parent.querySelector("[role='listbox'], [role='option'], .dropdown, .suggestions, .autocomplete-results") ??
					/autocomplete|typeahead|combobox|autosuggest/i.test(parent.className))) {
					autocomplete = true
				}
			}

			const field: typeof fields[number] = {
				label,
				placeholder: (el as HTMLInputElement).placeholder || undefined,
				inputType: el instanceof HTMLSelectElement ? "select" : ((el as HTMLInputElement).type || "text"),
				tag: el.tagName.toLowerCase(),
				required: (el as HTMLInputElement).required || el.getAttribute("aria-required") === "true",
			}

			if (autocomplete) {
				field.autocomplete = true
			}

			// Collect select options
			if (el instanceof HTMLSelectElement) {
				field.options = Array.from(el.options)
					.filter((o) => o.value !== "")
					.map((o) => o.text.trim())
			}

			fields.push(field)
		}

		return fields
	})
}

/**
 * Format form field metadata as readable text for LLM consumption.
 */
export function formatFormFields(fields: FormFieldInfo[]): string {
	if (fields.length === 0) return "(no form fields found)"
	return fields
		.map((f, i) => {
			const parts = [`${String(i + 1)}. <${f.tag}>`]
			if (f.label) parts.push(`label="${f.label}"`)
			if (f.placeholder) parts.push(`placeholder="${f.placeholder}"`)
			parts.push(`type="${f.inputType}"`)
			if (f.required) parts.push("[required]")
			if (f.autocomplete) parts.push("[autocomplete]")
			if (f.ref) parts.push(`ref=${f.ref}`)
			if (f.options && f.options.length > 0) {
				parts.push(`options: [${f.options.map((o) => `"${o}"`).join(", ")}]`)
			}
			return parts.join(" ")
		})
		.join("\n")
}
