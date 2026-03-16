/**
 * Page state capture: accessibility tree snapshots, screenshots, and console logs.
 */

import type { Page, Request } from "playwright"
import type { A11yNode, ConsoleEntry, PageState } from "../reporter/types.js"

// ── Network idle tracking ───────────────────────────────────────────

/**
 * Attach a network request tracker to a page.
 * Call once after page creation. The returned `waitForNetworkIdle` function
 * waits until all in-flight requests have completed (with a grace period
 * to allow follow-up requests to start).
 */
export function attachNetworkTracker(page: Page): {
	waitForNetworkIdle: (timeoutMs?: number) => Promise<void>
} {
	const pending = new Set<Request>()

	page.on("request", (req) => pending.add(req))
	page.on("requestfinished", (req) => pending.delete(req))
	page.on("requestfailed", (req) => pending.delete(req))

	return {
		/**
		 * Wait until the page has settled: network requests done AND
		 * rendered content stable. Two phases:
		 * 1. Wait for zero in-flight requests (with grace period for chained requests)
		 * 2. Wait for innerText to stop changing (catches CSS transitions/animations)
		 */
		async waitForNetworkIdle(timeoutMs = 5000): Promise<void> {
			const deadline = performance.now() + timeoutMs

			// Phase 1: wait for network requests to complete
			const networkGrace = 200
			let quietSince = pending.size === 0 ? performance.now() : 0
			while (performance.now() < deadline) {
				if (pending.size === 0) {
					if (!quietSince) quietSince = performance.now()
					if (performance.now() - quietSince >= networkGrace) break
				} else {
					quietSince = 0
				}
				await new Promise((r) => setTimeout(r, 50))
			}

			// Phase 2: wait for DOM content to stabilize.
			// Use textContent (not innerText) because some frameworks
			// render content that CSS hides from innerText during animations.
			// textContent sees all DOM text regardless of CSS.
			const contentGrace = 300
			let previous = ""
			try {
				previous =
					(await page.locator("body").textContent()) ?? ""
			} catch {
				return
			}
			let stableSince = performance.now()
			while (performance.now() < deadline) {
				await new Promise((r) => setTimeout(r, 100))
				let current = ""
				try {
					current =
						(await page.locator("body").textContent()) ?? ""
				} catch {
					return
				}
				if (current !== previous) {
					previous = current
					stableSince = performance.now()
				} else if (performance.now() - stableSince >= contentGrace) {
					return
				}
			}
		},
	}
}

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
 * Capture the page state: a11y tree, URL, title, console logs.
 * Screenshots are optional — skip them on pre-action captures to avoid
 * triggering lazy-loaded elements (e.g. IntersectionObserver-based maps).
 */
export async function capturePageState(
	page: Page,
	consoleDrain: () => ConsoleEntry[],
	options?: { screenshot?: boolean },
): Promise<PageState> {
	const takeScreenshot = options?.screenshot ?? false

	const [a11yRaw, screenshotBuffer, url, title] = await Promise.all([
		page.locator("body").ariaSnapshot(),
		takeScreenshot ? page.screenshot({ type: "png" }) : Promise.resolve(null),
		Promise.resolve(page.url()),
		page.title(),
	])

	const a11yTree = parseA11ySnapshot(a11yRaw)

	// Capture all text content on the page. This supplements the a11y tree
	// which can miss content rendered with non-semantic markup.
	// We use textContent (not innerText) because innerText skips elements
	// hidden by CSS transitions/animations that are still interactive.
	// Script and style content is excluded.
	let visibleText: string | undefined
	try {
		const raw = await page.evaluate(() => {
			function walk(node: Node): string {
				if (node.nodeType === 3) return node.textContent ?? "" // TEXT_NODE
				if (node.nodeType !== 1) return "" // Only process ELEMENT_NODE
				const el = node as Element
				const tag = el.tagName
				if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT")
					return ""
				const parts: string[] = []
				for (const child of el.childNodes) {
					parts.push(walk(child))
				}
				return parts.join("")
			}
			return walk(document.body)
		})
		// Collapse whitespace runs into single spaces, trim blank lines
		visibleText =
			raw
				.split("\n")
				.map((l) => l.replace(/\s+/g, " ").trim())
				.filter((l) => l.length > 0)
				.join("\n") || undefined
	} catch {
		// Skip if page is mid-navigation
	}

	const screenshot = screenshotBuffer
		? screenshotBuffer.toString("base64")
		: undefined
	const consoleLogs = consoleDrain()

	return { a11yTree, a11yRaw, visibleText, screenshot, url, title, consoleLogs }
}

// ── A11y snapshot parser ──────────────────────────────────────────────

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

/** Map from structural path → stable ref. Persists across captures within a test case. */
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
 * Refs are stable across captures: the same element (identified by its
 * structural path: role + name + sibling index at each tree level) always
 * gets the same ref within a test case.
 */
export function parseA11ySnapshot(raw: string): A11yNode[] {
	const lines = raw.split("\n")
	const rootNodes: A11yNode[] = []
	// Stack tracks: indent level, node, structural path prefix, and
	// sibling counters (role → count) for assigning sibling indices.
	const stack: {
		indent: number
		node: A11yNode
		pathPrefix: string
		siblingCounts: Map<string, number>
	}[] = []
	// Sibling counters at root level
	let rootSiblingCounts = new Map<string, number>()

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

		const node = buildNode(parsed, structuralPath)

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

function buildNode(parsed: ParsedLine, structuralPath: string): A11yNode {
	const isInteractive = INTERACTIVE_ROLES.has(parsed.role)
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
		) as NodeListOf<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>

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
				if (labelEl) label = labelEl.textContent?.trim()
			}
			if (!label && el.closest("label")) {
				const labelEl = el.closest("label")!
				// Get label text excluding the input's own text
				const clone = labelEl.cloneNode(true) as HTMLElement
				clone.querySelectorAll("input, textarea, select").forEach((c) => c.remove())
				label = clone.textContent?.trim()
			}
			if (!label && el.getAttribute("aria-label")) {
				label = el.getAttribute("aria-label")!
			}
			if (!label && el.getAttribute("aria-labelledby")) {
				const labelledBy = document.getElementById(el.getAttribute("aria-labelledby")!)
				if (labelledBy) label = labelledBy.textContent?.trim()
			}

			// Detect autocomplete/typeahead/combobox patterns
			let autocomplete = false
			const role = el.getAttribute("role")
			const ariaAuto = el.getAttribute("aria-autocomplete")
			const ariaExpanded = el.hasAttribute("aria-expanded")
			const ariaOwns = el.getAttribute("aria-owns") || el.getAttribute("aria-controls")
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
			const classes = (el.className || "") + " " + (el.closest("[class]")?.className || "")
			if (/autocomplete|typeahead|combobox|autosuggest|searchbox/i.test(classes)) {
				autocomplete = true
			}
			// Browser autocomplete="off" often indicates a custom autocomplete widget
			// (the site disables native autocomplete because it has its own)
			if (htmlAutocomplete === "off" && el instanceof HTMLInputElement && el.type === "text") {
				// Only flag as autocomplete if there are other hints (class patterns, nearby listboxes)
				const parent = el.parentElement
				if (parent && (parent.querySelector("[role='listbox'], [role='option'], .dropdown, .suggestions, .autocomplete-results") ||
					/autocomplete|typeahead|combobox|autosuggest/i.test(parent.className || ""))) {
					autocomplete = true
				}
			}

			const field: typeof fields[number] = {
				label: label || undefined,
				placeholder: (el as HTMLInputElement).placeholder || undefined,
				inputType: el instanceof HTMLSelectElement ? "select" : (el as HTMLInputElement).type || "text",
				tag: el.tagName.toLowerCase(),
				required: el.required || el.getAttribute("aria-required") === "true",
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
