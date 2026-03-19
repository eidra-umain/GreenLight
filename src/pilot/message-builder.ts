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
 * Message construction helpers for the LLM client.
 */

import type { A11yNode, PageState } from "../reporter/types.js"
import { formatA11yTree } from "./a11y-parser.js"
import { SYSTEM_PROMPT } from "./prompts.js"
import type { ChatMessage } from "./providers/types.js"

/**
 * Format the current local time as an ISO-like string with timezone offset.
 * E.g. "2026-03-19T10:25:00+01:00" — so the LLM computes relative times
 * in the user's local timezone (which is what date pickers expect).
 */
export function formatLocalTime(): string {
	const now = new Date()
	const off = -now.getTimezoneOffset()
	const sign = off >= 0 ? "+" : "-"
	const absOff = Math.abs(off)
	const hh = String(Math.floor(absOff / 60)).padStart(2, "0")
	const mm = String(absOff % 60).padStart(2, "0")
	const pad = (n: number) => String(n).padStart(2, "0")
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${sign}${hh}:${mm}`
}

/** Format map state as a human-readable string for the LLM. */
function formatMapState(mapState: PageState["mapState"]): string {
	if (!mapState) return ""
	const lines = [
		`  Adapter: ${mapState.adapter}`,
		`  Center: ${mapState.center.lng.toFixed(4)}, ${mapState.center.lat.toFixed(4)}`,
		`  Zoom: ${mapState.zoom.toFixed(2)}`,
		`  Bearing: ${mapState.bearing.toFixed(1)}°`,
		`  Pitch: ${mapState.pitch.toFixed(1)}°`,
		`  Bounds: SW(${mapState.bounds.sw.lng.toFixed(4)}, ${mapState.bounds.sw.lat.toFixed(4)}) — NE(${mapState.bounds.ne.lng.toFixed(4)}, ${mapState.bounds.ne.lat.toFixed(4)})`,
		`  Style loaded: ${String(mapState.styleLoaded)}`,
		`  Layers (${String(mapState.layers.length)}): ${mapState.layers.slice(0, 20).join(", ")}${mapState.layers.length > 20 ? ` ... and ${String(mapState.layers.length - 20)} more` : ""}`,
	]
	return lines.join("\n")
}

/**
 * Max characters for the formatted a11y tree before truncation kicks in.
 * ~80K chars ≈ ~20K tokens, leaving room for system prompt + history.
 */
const MAX_TREE_CHARS = 80_000

/**
 * Truncate a large a11y tree by summarizing repeated sibling groups.
 * When a parent has many children with the same role (e.g. 42 installer
 * cards each with dozens of child elements), show the first few in full
 * and summarize the rest as one-line entries (heading/name only).
 */
function truncateTree(nodes: A11yNode[], budget: number): string {
	const full = formatA11yTree(nodes)
	if (full.length <= budget) return full

	// Recursive approach: format nodes, but for large sibling groups
	// with the same role, show first 3 in full and summarize the rest.
	return formatTreeWithBudget(nodes, budget)
}

function formatTreeWithBudget(nodes: A11yNode[], budget: number, indent = 0): string {
	const lines: string[] = []
	const prefix = "  ".repeat(indent)

	// Group consecutive children by role to detect repeated patterns
	let i = 0
	while (i < nodes.length) {
		const node = nodes[i]

		// Check if this starts a run of siblings with the same role
		let runEnd = i + 1
		while (runEnd < nodes.length && nodes[runEnd].role === node.role && node.children && nodes[runEnd].children) {
			runEnd++
		}
		const runLength = runEnd - i

		if (runLength >= 6 && node.children) {
			// Large group of same-role siblings — show first 3 in full,
			// summarize the rest as compact one-liners
			const SHOW_FULL = 3
			for (let j = i; j < i + SHOW_FULL && j < runEnd; j++) {
				lines.push(formatA11yTree([nodes[j]], indent))
			}

			const remaining = runEnd - i - SHOW_FULL
			if (remaining > 0) {
				lines.push(`${prefix}... and ${String(remaining)} more ${node.role} elements (summarized):`)
				for (let j = i + SHOW_FULL; j < runEnd; j++) {
					const n = nodes[j]
					const refLabel = n.ref.startsWith("_") ? "" : `[${n.ref}] `
					const nameStr = n.name ? ` "${n.name}"` : ""
					// Find the first named child (usually a heading or button with the item name)
					const namedChild = n.children?.find((c) => c.name && (c.role === "heading" || c.role === "button" || c.role === "link"))
					const childInfo = namedChild ? ` → ${namedChild.role} "${namedChild.name}"` : ""
					lines.push(`${prefix}  ${refLabel}${n.role}${nameStr}${childInfo}`)
				}
			}
			i = runEnd
		} else {
			// Not a repeated group — format normally
			const refLabel = node.ref.startsWith("_") ? "" : `[${node.ref}] `
			const nameStr = node.name ? ` "${node.name}"` : ""
			const levelStr = node.level != null ? ` [level=${String(node.level)}]` : ""
			const urlStr = node.url ? ` → ${node.url}` : ""
			lines.push(`${prefix}${refLabel}${node.role}${nameStr}${levelStr}${urlStr}`)

			if (!node.ref.startsWith("_")) {
				const detailPrefix = prefix + "  "
				if (node.visibleText) lines.push(`${detailPrefix}text: "${node.visibleText}"`)
				if (node.placeholder) lines.push(`${detailPrefix}placeholder: "${node.placeholder}"`)
				if (node.value) lines.push(`${detailPrefix}value: "${node.value}"`)
			}

			if (node.children) {
				lines.push(formatTreeWithBudget(node.children, budget, indent + 1))
			}
			i++
		}

		// Early exit if we're already over budget
		const currentLength = lines.join("\n").length
		if (currentLength > budget * 1.2) {
			lines.push(`${prefix}... (truncated — ${String(nodes.length - i)} more elements)`)
			break
		}
	}

	return lines.join("\n")
}

/** Build the user message containing the step and full page state. */
export function buildUserMessage(step: string, pageState: PageState): string {
	const tree = truncateTree(pageState.a11yTree, MAX_TREE_CHARS)
	const parts = [
		`Current URL: ${pageState.url}`,
		`Page title: ${pageState.title}`,
		`Current local time: ${formatLocalTime()}`,
		"",
		"Accessibility tree:",
		tree,
	]

	if (pageState.mapState) {
		parts.push("", "Map state:", formatMapState(pageState.mapState))
	}

	parts.push("", `Step to execute: ${step}`)
	return parts.join("\n")
}

/**
 * Compute a line-level diff between two tree strings.
 * Returns added and removed lines, preserving order.
 */
export function computeTreeDiff(
	oldTree: string,
	newTree: string,
): { added: string[]; removed: string[]; changedRatio: number } {
	const oldLines = oldTree.split("\n")
	const newLines = newTree.split("\n")
	const oldSet = new Set(oldLines)
	const newSet = new Set(newLines)
	const added = newLines.filter((l) => !oldSet.has(l))
	const removed = oldLines.filter((l) => !newSet.has(l))
	const total = Math.max(oldLines.length, newLines.length)
	return {
		added,
		removed,
		changedRatio: total > 0 ? (added.length + removed.length) / total : 0,
	}
}

/**
 * Build a compact message for subsequent steps on the same page.
 * Refs are stable across captures (derived from structural identity), so:
 * - If the a11y tree is identical: skip both tree and visible text ("unchanged").
 * - If < 30% of tree lines changed: send only the diff ("tree-diff").
 * - If >= 30% changed: send the full enriched tree ("tree-only").
 * Returns null if we should send full state instead (e.g. after navigation).
 */
export function buildCompactMessage(
	step: string,
	pageState: PageState,
	prevState: PageState,
	prevTree: string,
): { message: string; mode: "unchanged" | "tree-diff" | "tree-only" } | null {
	// If the URL path changed, the page is fundamentally different — send full state
	try {
		const oldPath = new URL(prevState.url).pathname
		const newPath = new URL(pageState.url).pathname
		if (oldPath !== newPath) return null
	} catch {
		return null
	}

	const tree = formatA11yTree(pageState.a11yTree)
	const treeUnchanged = tree === prevTree

	if (treeUnchanged) {
		const parts = [
			`Current URL: ${pageState.url}`,
			"",
			"Page state is unchanged from the previous step. All element refs remain the same.",
			"",
			`Step to execute: ${step}`,
		]
		return { message: parts.join("\n"), mode: "unchanged" }
	}

	const { added, removed, changedRatio } = computeTreeDiff(prevTree, tree)

	// Small change — send just the diff. Refs are stable so the LLM can
	// combine this with the full tree it saw earlier.
	if (changedRatio < 0.3) {
		const parts = [
			`Current URL: ${pageState.url}`,
			"",
			"Accessibility tree changes (refs are stable — unchanged elements keep their refs from the previous message):",
		]
		if (removed.length > 0) {
			parts.push("Removed elements:")
			for (const line of removed) parts.push(`  - ${line.trim()}`)
		}
		if (added.length > 0) {
			parts.push("New/changed elements:")
			for (const line of added) parts.push(`  + ${line.trim()}`)
		}
		parts.push("", `Step to execute: ${step}`)
		return { message: parts.join("\n"), mode: "tree-diff" }
	}

	// Large change — send full enriched tree
	const parts = [
		`Current URL: ${pageState.url}`,
		`Page title: ${pageState.title}`,
		"",
		"Accessibility tree (updated — refs are stable, only changed elements have new/removed entries):",
		tree,
		"",
		`Step to execute: ${step}`,
	]
	return { message: parts.join("\n"), mode: "tree-only" }
}

/** Build the full messages array for a chat completion request. */
export function buildMessages(
	step: string,
	pageState: PageState,
): ChatMessage[] {
	return [
		{ role: "system", content: SYSTEM_PROMPT },
		{ role: "user", content: buildUserMessage(step, pageState) },
	]
}
