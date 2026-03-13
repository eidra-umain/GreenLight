/**
 * Page state capture: accessibility tree snapshots, screenshots, and console logs.
 */

import type { Page } from "playwright"
import type { A11yNode, ConsoleEntry, PageState } from "../reporter/types.js"

/**
 * Collect console messages from a page.
 * Call attachConsoleCollector(page) once after page creation,
 * then drainConsoleLogs() to retrieve and clear collected entries.
 */
export function attachConsoleCollector(page: Page): {
	drain: () => ConsoleEntry[]
} {
	const logs: ConsoleEntry[] = []

	page.on("console", (msg) => {
		logs.push({ type: msg.type(), text: msg.text() })
	})

	return {
		drain() {
			const snapshot = [...logs]
			logs.length = 0
			return snapshot
		},
	}
}

/**
 * Capture the full page state: a11y tree, screenshot, URL, title, console logs.
 */
export async function capturePageState(
	page: Page,
	consoleDrain: () => ConsoleEntry[],
): Promise<PageState> {
	const [a11yRaw, screenshotBuffer, url, title] = await Promise.all([
		page.locator("body").ariaSnapshot(),
		page.screenshot({ type: "png" }),
		Promise.resolve(page.url()),
		page.title(),
	])

	const a11yTree = parseA11ySnapshot(a11yRaw)
	const screenshot = screenshotBuffer.toString("base64")
	const consoleLogs = consoleDrain()

	return { a11yTree, a11yRaw, screenshot, url, title, consoleLogs }
}

// ── A11y snapshot parser ──────────────────────────────────────────────

let refCounter = 0

/** Reset the ref counter (call between test cases). */
export function resetRefCounter(): void {
	refCounter = 0
}

function nextRef(): string {
	refCounter++
	return `e${String(refCounter)}`
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

interface ParsedLine {
	indent: number
	role: string
	name: string
	attrs: string[]
	url?: string
	raw: string
}

/**
 * Parse Playwright's ariaSnapshot YAML-like output into A11yNode tree with refs.
 */
export function parseA11ySnapshot(raw: string): A11yNode[] {
	const lines = raw.split("\n")
	const rootNodes: A11yNode[] = []
	const stack: { indent: number; node: A11yNode }[] = []

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

		const node = buildNode(parsed)

		// Find parent based on indent level
		while (stack.length > 0) {
			const top = stack.at(-1)
			if (top && top.indent >= parsed.indent) {
				stack.pop()
			} else {
				break
			}
		}

		const parent = stack.at(-1)
		if (!parent) {
			rootNodes.push(node)
		} else {
			parent.node.children ??= []
			parent.node.children.push(node)
		}

		stack.push({ indent: parsed.indent, node })
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

function buildNode(parsed: ParsedLine): A11yNode {
	const isInteractive = INTERACTIVE_ROLES.has(parsed.role)
	const ref = isInteractive ? nextRef() : `_${parsed.role}`

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

		lines.push(
			`${prefix}${refLabel}${node.role}${nameStr}${levelStr}${urlStr}`,
		)

		if (node.children) {
			lines.push(formatA11yTree(node.children, indent + 1))
		}
	}

	return lines.join("\n")
}
