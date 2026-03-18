/**
 * Accessibility tree snapshot parser with stable ref assignment.
 */

import type { A11yNode } from "../reporter/types.js"

// ── Stable ref assignment ─────────────────────────────────────────────

/**
 * Stable ref assignment.
 *
 * Refs are derived from a structural path: each interactive element gets a
 * ref based on its role, name, and sibling index among same-role siblings.
 * This makes refs stable across captures — a button "Submit" keeps its ref
 * even when new elements appear elsewhere in the tree.
 *
 * A short integer ref (e1, e2, ...) is assigned to each unique structural
 * path via a persistent map that survives across captures within a test case.
 * New elements get the next available integer. Removed elements keep their
 * slot so that the LLM never sees a ref reassigned to a different element.
 */

/** Map from structural path -> stable ref. Persists across captures within a test case. */
let stableRefMap = new Map<string, string>()
let nextRefId = 0

/** Reset stable ref tracking (call between test cases). */
export function resetRefCounter(): void {
	stableRefMap = new Map<string, string>()
	nextRefId = 0
}

/**
 * Get or assign a stable ref for a structural path.
 * The path encodes the element's position: role, name, and sibling index
 * at each level of the tree.
 */
function getStableRef(structuralPath: string): string {
	const existing = stableRefMap.get(structuralPath)
	if (existing) return existing
	nextRefId++
	const ref = `e${String(nextRefId)}`
	stableRefMap.set(structuralPath, ref)
	return ref
}

/**
 * Roles that represent interactive elements the Pilot can act on.
 * Non-interactive structural roles (list, listitem, paragraph, etc.)
 * still appear in the tree but don't get refs.
 */
const INTERACTIVE_ROLES = new Set([
	"link",
	"button",
	"searchbox",
	"textbox",
	"checkbox",
	"radio",
	"combobox",
	"menuitem",
	"menuitemcheckbox",
	"menuitemradio",
	"option",
	"slider",
	"spinbutton",
	"switch",
	"tab",
	"treeitem",
	"img",
	"heading",
])

export interface ParsedLine {
	indent: number
	role: string
	name: string
	attrs: string[]
	url?: string
	raw: string
}

/**
 * Parse Playwright's ariaSnapshot YAML-like output into A11yNode tree with refs.
 * Refs are stable across captures: the same element (identified by its
 * structural path: role + name + sibling index at each tree level) always
 * gets the same ref within a test case.
 */
export function parseA11ySnapshot(raw: string): A11yNode[] {
	const lines = raw.split("\n")
	const rootNodes: A11yNode[] = []
	// Stack tracks: indent level, node, structural path prefix, and
	// sibling counters (role -> count) for assigning sibling indices.
	const stack: {
		indent: number
		node: A11yNode
		pathPrefix: string
		siblingCounts: Map<string, number>
	}[] = []
	// Sibling counters at root level
	const rootSiblingCounts = new Map<string, number>()

	for (const line of lines) {
		if (!line.trim()) continue

		// Metadata lines like "  - /url: ..." — attach to parent
		const urlMatch = /^(\s*)- \/url:\s*(.+)$/.exec(line)
		if (urlMatch) {
			const lastNode = stack.at(-1)?.node
			if (lastNode) {
				lastNode.url = urlMatch[2].trim()
			}
			continue
		}

		const parsed = parseLine(line)
		if (!parsed) continue

		// Find parent based on indent level
		while (stack.length > 0) {
			const top = stack.at(-1)
			if (top && top.indent >= parsed.indent) {
				stack.pop()
			} else {
				break
			}
		}

		// Compute structural path for stable ref assignment
		const parent = stack.at(-1)
		const siblingCounts = parent ? parent.siblingCounts : rootSiblingCounts
		const pathPrefix = parent ? parent.pathPrefix : ""

		// Sibling key: role + name (elements with the same role and name
		// under the same parent get distinguished by index)
		const siblingKey = `${parsed.role}:${parsed.name}`
		const siblingIndex = siblingCounts.get(siblingKey) ?? 0
		siblingCounts.set(siblingKey, siblingIndex + 1)

		const structuralPath = `${pathPrefix}/${parsed.role}:${parsed.name}[${String(siblingIndex)}]`

		const node = buildNode(parsed, structuralPath, parent?.node.role)

		if (!parent) {
			rootNodes.push(node)
		} else {
			parent.node.children ??= []
			parent.node.children.push(node)
		}

		stack.push({
			indent: parsed.indent,
			node,
			pathPrefix: structuralPath,
			siblingCounts: new Map<string, number>(),
		})
	}

	return rootNodes
}

function parseLine(line: string): ParsedLine | null {
	// Match: "  - role "name" [attrs]" or "  - role: text" or "  - role"
	const match = /^(\s*)- (\w+)(?:\s+"([^"]*)")?(.*)$/.exec(line)
	if (!match) return null

	const [, spaces, role, quotedName, remainder] = match
	const indent = spaces.length
	let name = quotedName || ""
	const rest = remainder.trim()

	// Parse attributes like [level=1] [checked]
	const attrs: string[] = []
	const attrMatches = rest.matchAll(/\[([^\]]+)\]/g)
	for (const m of attrMatches) {
		attrs.push(m[1])
	}

	// If no quoted name, check for "role: text" pattern
	if (!name && rest.startsWith(":")) {
		name = rest.slice(1).trim()
	}

	// Extract level from attrs
	const levelAttr = attrs.find((a) => a.startsWith("level="))

	return {
		indent,
		role,
		name,
		attrs,
		raw: line.trim(),
		...(levelAttr ? {} : {}),
	}
}

function buildNode(parsed: ParsedLine, structuralPath: string, parentRole?: string): A11yNode {
	// A node is interactive if it has an interactive role, OR if it's a
	// text node inside a radiogroup/listbox (custom radio cards, option lists).
	const isInteractive = INTERACTIVE_ROLES.has(parsed.role)
		|| (parsed.role === "text" && (parentRole === "radiogroup" || parentRole === "listbox"))
	const ref = isInteractive ? getStableRef(structuralPath) : `_${parsed.role}`

	const node: A11yNode = {
		ref,
		role: parsed.role,
		name: parsed.name,
		raw: parsed.raw,
	}

	// Extract level for headings
	const levelAttr = parsed.attrs.find((a) => a.startsWith("level="))
	if (levelAttr) {
		node.level = parseInt(levelAttr.split("=")[1], 10)
	}

	return node
}

/**
 * Format the a11y tree as a readable string with refs, for display and LLM consumption.
 */
export function formatA11yTree(nodes: A11yNode[], indent = 0): string {
	const lines: string[] = []
	const prefix = "  ".repeat(indent)

	for (const node of nodes) {
		const refLabel = node.ref.startsWith("_") ? "" : `[${node.ref}] `
		const nameStr = node.name ? ` "${node.name}"` : ""
		const levelStr = node.level != null ? ` [level=${String(node.level)}]` : ""
		const urlStr = node.url ? ` → ${node.url}` : ""

		lines.push(`${prefix}${refLabel}${node.role}${nameStr}${levelStr}${urlStr}`)

		if (node.children) {
			lines.push(formatA11yTree(node.children, indent + 1))
		}
	}

	return lines.join("\n")
}
