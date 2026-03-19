/**
 * Date/time picker resolver — parses relative time expressions with chrono-node
 * and maps them to concrete actions against date picker elements in the a11y tree.
 * No LLM calls needed.
 */

import * as chrono from "chrono-node"
import type { A11yNode, Action } from "../reporter/types.js"
import type { PlannedStep } from "./response-parser.js"
import { globals } from "../globals.js"

/** Roles that represent date/time picker sections. */
const PICKER_ROLES = new Set(["spinbutton", "textbox"])

/** Labels for date/time sections (case-insensitive matching). */
const SECTION_PATTERNS: { label: RegExp; extract: (d: Date) => string }[] = [
	{ label: /\bday\b/i, extract: (d) => String(d.getDate()).padStart(2, "0") },
	{ label: /\bmonth\b/i, extract: (d) => String(d.getMonth() + 1).padStart(2, "0") },
	{ label: /\byear\b/i, extract: (d) => String(d.getFullYear()) },
	{ label: /\bhour/i, extract: (d) => String(d.getHours()).padStart(2, "0") },
	{ label: /\bminute/i, extract: (d) => String(d.getMinutes()).padStart(2, "0") },
	{ label: /\bsecond/i, extract: (d) => String(d.getSeconds()).padStart(2, "0") },
	{
		label: /\bmeridiem\b|\b[ap]m\b/i,
		extract: (d) => (d.getHours() >= 12 ? "PM" : "AM"),
	},
]

/**
 * Find date/time picker groups in the a11y tree.
 * A picker group is a `group` node containing spinbutton/textbox children
 * with date/time-related labels (Day, Month, Year, Hours, Minutes).
 */
function findPickerGroups(nodes: A11yNode[]): { name: string; sections: A11yNode[] }[] {
	const groups: { name: string; sections: A11yNode[] }[] = []

	function walk(list: A11yNode[]) {
		for (const node of list) {
			if (node.role === "group" && node.children) {
				const sections = node.children.filter(
					(c) => PICKER_ROLES.has(c.role) && !c.ref.startsWith("_") &&
						SECTION_PATTERNS.some((p) => p.label.test(c.name)),
				)
				if (sections.length >= 2) {
					groups.push({ name: node.name || "", sections })
				}
			}
			if (node.children) walk(node.children)
		}
	}

	walk(nodes)
	return groups
}

/**
 * Find a single native date/time input (type="date", "datetime-local", "time")
 * in the a11y tree by matching step text keywords.
 */
function findNativeDateInput(nodes: A11yNode[], stepLower: string): A11yNode | null {
	function walk(list: A11yNode[]): A11yNode | null {
		for (const node of list) {
			if (PICKER_ROLES.has(node.role) && !node.ref.startsWith("_")) {
				const nameLower = node.name.toLowerCase()
				// Match if the node name contains date/time-related keywords from the step
				if (
					(stepLower.includes("date") && nameLower.includes("date")) ||
					(stepLower.includes("time") && (nameLower.includes("time") || nameLower.includes("hour"))) ||
					nameLower.includes("date") || nameLower.includes("time")
				) {
					return node
				}
			}
			if (node.children) {
				const found = walk(node.children)
				if (found) return found
			}
		}
		return null
	}
	return walk(nodes)
}

/**
 * Resolve a date picker step into concrete actions.
 * Parses the relative time expression with chrono-node, finds the picker
 * elements in the a11y tree, and returns pre-resolved type actions.
 *
 * @param step The original step text (e.g. "set the start time to 10 minutes from now")
 * @param a11yTree The current page's accessibility tree
 * @returns Array of pre-resolved PlannedSteps with type actions and refs
 */
export function resolveDatePick(step: string, a11yTree: A11yNode[]): PlannedStep[] {
	// Extract time expression if separated by "||"
	// Format: "full step description||time expression"
	let description = step
	let timeExpr = step
	const sepIdx = step.indexOf("||")
	if (sepIdx !== -1) {
		description = step.slice(0, sepIdx)
		timeExpr = step.slice(sepIdx + 2)
	}

	// Parse the date/time from the time expression
	const parsed = chrono.parseDate(timeExpr)
	if (!parsed) {
		throw new Error(`Could not parse a date/time from: "${timeExpr}"`)
	}

	if (globals.debug) {
		console.log(`      [datepick] Expression: "${timeExpr}" → ${parsed.toISOString()} (local: ${parsed.toLocaleString()})`)
	}

	const stepLower = description.toLowerCase()
	const results: PlannedStep[] = []

	// Strategy 1: Sectioned picker (MUI v7, etc.) — group with spinbuttons
	const groups = findPickerGroups(a11yTree)
	if (groups.length > 0) {
		// Find the right group by matching step text against group name
		let targetGroup = groups[0]
		if (groups.length > 1) {
			// Match step keywords against group names to find the right picker.
			// Only match explicit start/end/begin/until words — avoid false
			// positives from common words like "from" or "to".
			const stepWords = stepLower.split(/\s+/)
			for (const g of groups) {
				const gLower = g.name.toLowerCase()
				if (
					(stepWords.includes("start") && gLower.includes("start")) ||
					(stepWords.includes("end") && gLower.includes("end")) ||
					(stepWords.includes("begin") && gLower.includes("start")) ||
					(stepWords.includes("until") && gLower.includes("end"))
				) {
					targetGroup = g
					break
				}
			}
		}

		if (globals.debug) {
			console.log(`      [datepick] Target group: "${targetGroup.name}" (${String(targetGroup.sections.length)} sections)`)
		}

		// Map each section to a type action
		for (const section of targetGroup.sections) {
			for (const pattern of SECTION_PATTERNS) {
				if (pattern.label.test(section.name)) {
					const value = pattern.extract(parsed)
					const action: Action = { action: "type", ref: section.ref, value }
					results.push({
						step: `type ${section.ref} = "${value}"`,
						action,
					})
					break
				}
			}
		}

		if (results.length > 0) return results
	}

	// Strategy 2: Native date/time input — single element
	const nativeInput = findNativeDateInput(a11yTree, stepLower)
	if (nativeInput) {
		// Determine format from input type/name
		const nameLower = nativeInput.name.toLowerCase()
		let value: string
		if (nameLower.includes("time") && !nameLower.includes("date")) {
			// Time only
			value = `${String(parsed.getHours()).padStart(2, "0")}:${String(parsed.getMinutes()).padStart(2, "0")}`
		} else if (nameLower.includes("date") && !nameLower.includes("time")) {
			// Date only
			value = `${String(parsed.getFullYear())}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`
		} else {
			// Datetime
			value = `${String(parsed.getFullYear())}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}T${String(parsed.getHours()).padStart(2, "0")}:${String(parsed.getMinutes()).padStart(2, "0")}`
		}

		results.push({
			step: `type ${nativeInput.ref} = "${value}"`,
			action: { action: "type", ref: nativeInput.ref, value },
		})
		return results
	}

	throw new Error(`Could not find a date/time picker in the accessibility tree for: "${step}"`)
}
