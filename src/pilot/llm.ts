/**
 * Provider-agnostic LLM client using the OpenAI-compatible chat completions API.
 * Default backend: OpenRouter. Works with any OpenAI-compatible endpoint.
 */

import type { RunConfig } from "../types.js"
import type { Action, PageState } from "../reporter/types.js"
import { formatA11yTree, captureFormFields, formatFormFields } from "./state.js"
import type { Page } from "playwright"
import { globals } from "../globals.js"

/** Configuration for the LLM client. */
export interface LLMClientConfig {
	apiKey: string
	baseUrl: string
	model: string
}

/** A chat message in the OpenAI format. */
export interface ChatMessage {
	role: "system" | "user" | "assistant"
	content: string
}

/** A single planned step: the display label and either a pre-resolved action or null. */
export interface PlannedStep {
	step: string
	action: Action | null
	/** If true, this step needs runtime expansion into multiple sub-actions (e.g. form filling). */
	needsExpansion?: boolean
}

/** The LLM client interface. */
export interface LLMClient {
	/**
	 * Pre-plan all steps by sending the full test spec to the LLM.
	 * The LLM interprets each step, potentially splitting compound steps
	 * into multiple atomic actions. Returns a flat list of planned steps.
	 */
	planSteps(steps: string[]): Promise<PlannedStep[]>
	/** Resolve a single step using the page state and a11y tree. */
	resolveStep(step: string, pageState: PageState): Promise<Action>
	/**
	 * Expand a compound step into multiple atomic actions using live page state.
	 * Used for steps like "fill in the form" that need to see the actual form
	 * fields before they can be decomposed into individual type/select/click actions.
	 */
	expandStep(
		step: string,
		pageState: PageState,
		page: Page,
	): Promise<PlannedStep[]>
	/** Reset conversation history (call between test cases). */
	resetHistory(): void
}

/** System prompt that defines the Pilot's persona and expected response format. */
export const SYSTEM_PROMPT = `You are The Pilot, an AI agent that executes end-to-end tests in a web browser.

You receive a plain-English test step and the current page state.

The page state may be provided in different levels of detail:
- Full state: complete accessibility tree + visible page text (first step and after navigation).
- Tree diff: only the added/removed lines from the accessibility tree (when a small part of the page changed, e.g. a form wizard step). Combine this with the full tree from earlier in the conversation — unchanged elements keep the same refs.
- Unchanged: the page is identical to the previous step.

Element refs (e1, e2, ...) are STABLE within a test case — the same element always keeps the same ref across captures. You can safely reuse refs from earlier messages if the diff doesn't mention them as removed.

Your job is to determine the SINGLE browser action needed to execute the step.

Available actions:
- click: Click an element. Requires "ref" or "text".
- check: Check a checkbox. Requires "ref" or "text". Use this instead of click for checkboxes.
- uncheck: Uncheck a checkbox. Requires "ref" or "text".
- type: Type text into an input. Requires "ref" or "text", and "value".
- select: Select an option from a dropdown. Requires "ref" or "text", and "value" (the option label).
- autocomplete: Type into an autocomplete/typeahead field, wait for suggestions to appear, and click one. Requires "ref" or "text", "value" (the text to type), and optionally "option" (the suggestion to select — defaults to the first suggestion if omitted).
- scroll: Scroll the page. Requires "value" ("up" or "down"). Optional "ref" to scroll a specific element.
- navigate: Navigate to a URL. Requires "value" (the URL or path).
- press: Press a keyboard key. Requires "value" (key name, e.g. "Enter", "Tab", "Escape").
- wait: Wait for a condition. Requires "value" (description of what to wait for).
- assert: Check a condition on the page. Requires "assertion" with "type" and "expected".
  Assertion types: "contains_text", "not_contains_text", "url_contains", "element_visible", "element_not_visible", "link_exists", "field_exists".

Element targeting:
- Use "ref" when the target element appears in the accessibility tree (preferred).
- Use "text" when the target is NOT in the accessibility tree but is visible on the page. The text value should match the visible text of the element you want to interact with. This is common when page markup lacks proper ARIA roles.
- Never guess a ref. If the element you need is not in the tree, use "text" instead.
- A "Visible page text" section shows what a human actually sees on the page. Use it to find elements that are missing from the accessibility tree — target them with "text" matching their visible label.

IMPORTANT: Any step that starts with "check that" is ALWAYS an assertion. Never return a click, type, or other interaction for a "check that" step.

Respond with ONLY a JSON object. No markdown, no explanation. Example responses:

{"action":"click","ref":"e5"}
{"action":"click","text":"About us"}
{"action":"type","ref":"e3","value":"jane@example.com"}
{"action":"select","ref":"e8","value":"Canada"}
{"action":"autocomplete","ref":"e4","value":"foo"}
{"action":"autocomplete","ref":"e4","value":"foo","option":"foobar inc"}
{"action":"check","ref":"e12"}
{"action":"navigate","value":"/products"}
{"action":"press","value":"Enter"}
{"action":"assert","assertion":{"type":"contains_text","expected":"Welcome back"}}
{"action":"scroll","value":"down"}
`

// ── Step planning prompt ─────────────────────────────────────────────

export const PLAN_SYSTEM_PROMPT = `We are processing a test description for an automated E2E testing tool.

It has a list of test steps in natural language that you should convert into actions using a simple line-based format. Output one line per action. A single input step may produce multiple output lines if it describes a sequence of actions.

Action syntax (one per line):
- PAGE "description" — needs the live page to resolve (click, type, select interactions). The description should be a clear, atomic instruction.
- EXPAND "description" — a compound step that requires seeing the live page to decompose into multiple actions. Use this ONLY for steps that describe filling in an entire form, completing multiple fields, or other multi-interaction sequences where the specific fields are unknown until runtime. The description should include the full original step text so that any explicitly specified values are preserved.
- assert contains_text "text"
- assert not_contains_text "text"
- assert url_contains "text"
- assert element_visible "text"
- assert element_not_visible "text"
- assert link_exists "href"
- assert field_exists "label"
- navigate "url"
- press "key"
- scroll "up|down"

Rules:
- Any step that says "check that" or "verify" or similar language is ALWAYS an assertion.
- Assertions with explicit quoted strings (e.g. check that the page contains "Welcome") can be resolved as literal assertions: assert contains_text "Welcome"
- Assertions WITHOUT quoted strings describe something conceptual (e.g. "check that the page contains a Leads form", "check that there is a contact section"). These CANNOT be pre-resolved because the actual page text may differ from the description. Output PAGE with the full step as description so the runtime LLM can inspect the page.
- For assertions that CAN be resolved, preserve the FULL expected text exactly as written. Never truncate or shorten it.
- Steps that require seeing the page to identify interactive elements → PAGE with a description.
- IMPORTANT: Each output line must describe exactly ONE atomic interaction (one click, one type, one select). If an input step describes or implies multiple interactions — whether separated by dashes, commas, slashes, "then", "and", or simply listing several values/items/choices — split it into one PAGE line per interaction. Always err on the side of splitting: if a step could be multiple actions, it IS multiple actions.
- When splitting a step into multiple actions, PRESERVE the full original context in each sub-step description. The runtime LLM will see each sub-step independently without knowledge of the others, so each description must be self-contained and unambiguous. Include enough detail to identify the correct element (e.g. mention the form name, section, or UI context).
  For example:
  Input: "Select Företag - Ventilation - Kylteknik in the leads form" → three lines:
  PAGE "click the 'Företag' button/tab in the leads form (first selection in the sequence Företag - Ventilation - Kylteknik)"
  PAGE "click 'Ventilation' in the leads form (second selection after Företag was selected)"
  PAGE "click 'Kylteknik' in the leads form (third selection after Företag and Ventilation were selected)"
  Input: "Fill in name, email and phone" → three lines:
  PAGE "fill in the name field"
  PAGE "fill in the email field"
  PAGE "fill in the phone field"
- EXCEPTION: If a step describes filling in an entire form without listing specific fields 
  (e.g. "fill in the form with some test data and submit it", "complete the contact form with email foo@bar.com"), 
  use a single EXPAND line instead of splitting. EXPAND means the runtime will inspect the actual form fields on the page
  and generate appropriate actions. Include the full original text so any explicit values are preserved.
  For example:
  Input: "fill in the form with some test data and submit it" → one line:
  EXPAND "fill in the form with some test data and submit it"
  Input: "fill in the form with email foo@example.com and some test data" → one line:
  EXPAND "fill in the form with email foo@example.com and some test data"
- No blank lines, no numbering, no explanation. Only action lines.
`

// ── Step expansion prompt (runtime, with page context) ──────────────

export const EXPAND_SYSTEM_PROMPT = `You are expanding a high-level test step into concrete atomic actions based on the actual form fields visible on the page.

You receive:
1. The original step instruction (which may specify some values explicitly and leave others to your judgement).
2. The accessibility tree of the current page (with element refs).
3. A detailed list of form fields with their label, placeholder, input type, required status, and available options.

Your job is to produce one action line per interaction needed to fulfill the step. Use the same line-based format:
- PAGE "type <value> into the <field label/placeholder> field" — for regular text input fields. Always reference the field by its label or placeholder as shown in the form fields list.
- PAGE "type <value> into the <field label/placeholder> autocomplete field and select the first suggestion" — for fields marked [autocomplete]. This tells the runtime to type, wait for the dropdown, and click the first option.
- PAGE "type <value> into the <field label/placeholder> autocomplete field and select <specific option>" — when the step specifies a particular option to pick from the autocomplete suggestions.
- PAGE "select <option> in the <field label> dropdown" — for select fields.
- PAGE "check the <label> checkbox" — for checkboxes.
- PAGE "click the <button text> button" — for submit or other buttons.
- press "Enter" — if the form should be submitted via Enter key.

Rules for autocomplete fields (marked [autocomplete] in the field list):
- These are typeahead/combobox fields that show a dropdown of suggestions as the user types.
- ALWAYS use the "autocomplete field" phrasing so the runtime knows to wait for and interact with the dropdown.
- By default, select the first suggestion unless the step explicitly names a different choice.
- Type a short search term that is likely to produce relevant results (e.g. first few characters of an expected value).

Rules for choosing test data:
- If the step explicitly provides a value for a field (e.g. "with email foo@example.com"), use that EXACT value for the matching field. Match by field purpose — the step may say "email" while the field label says "E-post" or "Mail address".
- For fields NOT explicitly specified, generate realistic fake test data appropriate for the field. Use the field's label, placeholder, and input type to determine what kind of data to generate:
  - Use the input type attribute (email, tel, url, number, etc.) to pick the right format.
  - Read the label and placeholder text (in whatever language they are written) to understand what the field expects, then generate a plausible value.
  - For free-text or message fields, use a short generic test string like "Test message".
- For select/dropdown fields: pick the first non-empty option unless the step specifies a value.
- For checkbox fields: check them if it sounds like it is needed. This includes consent checkboxes such as terms of service, privacy policy, data processing agreements, cookie consent, or similar — these must be checked for the form submission to succeed.
- For required fields: always include them.
- For optional fields: include them too (fill the whole form).
- If the step says "submit" or similar, include a click on the submit button as the last action.

Output ONLY action lines, one per line. No blank lines, no numbering, no explanation.
`

// ── Message construction ────────────────────────────────────────────

/** Build the user message containing the step and full page state. */
export function buildUserMessage(step: string, pageState: PageState): string {
	const tree = formatA11yTree(pageState.a11yTree)
	const parts = [
		`Current URL: ${pageState.url}`,
		`Page title: ${pageState.title}`,
		"",
		"Accessibility tree:",
		tree,
	]

	if (pageState.visibleText) {
		parts.push("", "Visible page text:", pageState.visibleText)
	}

	parts.push("", `Step to execute: ${step}`)
	return parts.join("\n")
}

/**
 * Compute a line-level diff between two tree strings.
 * Returns added and removed lines, preserving order.
 */
function computeTreeDiff(
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
 * - If >= 30% changed: send the full tree without visible text ("tree-only").
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

	// Large change — send full tree without visible text
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

/** Parse a JSON string from the LLM into a validated Action. */
export function parseActionResponse(raw: string): Action {
	// Strip markdown code fences if the LLM wraps in ```json
	let cleaned = raw.trim()
	if (cleaned.startsWith("```")) {
		cleaned = cleaned.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "")
	}

	let parsed: unknown
	try {
		parsed = JSON.parse(cleaned)
	} catch {
		throw new Error(`LLM returned invalid JSON: ${raw}`)
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`LLM returned non-object JSON: ${raw}`)
	}

	const obj = parsed as Record<string, unknown>

	if (typeof obj.action !== "string" || obj.action.length === 0) {
		throw new Error(`LLM response missing "action" field: ${raw}`)
	}

	const VALID_ACTIONS = [
		"click",
		"check",
		"uncheck",
		"type",
		"select",
		"autocomplete",
		"scroll",
		"navigate",
		"press",
		"wait",
		"assert",
	]

	if (!VALID_ACTIONS.includes(obj.action)) {
		throw new Error(
			`LLM returned unknown action "${obj.action}". Valid: ${VALID_ACTIONS.join(", ")}`,
		)
	}

	const action: Action = { action: obj.action }

	if (typeof obj.ref === "string") {
		action.ref = obj.ref
	}
	if (typeof obj.text === "string") {
		action.text = obj.text
	}
	if (typeof obj.value === "string") {
		action.value = obj.value
	}
	if (typeof obj.option === "string") {
		action.option = obj.option
	}
	if (typeof obj.assertion === "object" && obj.assertion !== null) {
		const a = obj.assertion as Record<string, unknown>
		if (typeof a.type === "string" && typeof a.expected === "string") {
			action.assertion = { type: a.type, expected: a.expected }
		}
	}

	return action
}

/** Resolve the API key from environment variables. */
export function resolveApiKey(): string {
	const key = process.env.OPENROUTER_API_KEY ?? process.env.LLM_API_KEY
	if (!key) {
		throw new Error(
			"No API key found. Set OPENROUTER_API_KEY or LLM_API_KEY environment variable.",
		)
	}
	return key
}

/** Resolve LLM client config from RunConfig and environment. */
export function resolveLLMConfig(runConfig: RunConfig): LLMClientConfig {
	return {
		apiKey: resolveApiKey(),
		baseUrl: runConfig.llmBaseUrl,
		model: runConfig.model,
	}
}

/**
 * Create an LLM client that maintains conversation history within a test case.
 * The system prompt is sent once. Each step adds a user message and the LLM's
 * response to the history, giving the model context about prior actions.
 * Call resetHistory() between test cases.
 */
export function createLLMClient(config: LLMClientConfig): LLMClient {
	const endpoint = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`
	let history: ChatMessage[] = []
	const cache = new Map<string, Action>()
	let prevPageState: PageState | null = null
	let prevFormattedTree = ""

	async function chatCompletion(messages: ChatMessage[]): Promise<string> {
		const response = await fetch(endpoint, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${config.apiKey}`,
			},
			body: JSON.stringify({
				model: config.model,
				messages,
				temperature: 0,
			}),
		})

		if (!response.ok) {
			const body = await response.text()
			throw new Error(`LLM API error ${String(response.status)}: ${body}`)
		}

		const data = (await response.json()) as {
			choices: { message: { content: string } }[]
		}

		const content = data.choices[0]?.message?.content
		if (!content) {
			throw new Error("LLM returned empty response")
		}

		return content
	}

	return {
		resetHistory() {
			history = []
			prevPageState = null
			prevFormattedTree = ""
		},

		async planSteps(steps: string[]): Promise<PlannedStep[]> {
			const userMessage = steps
				.map((s, i) => `${String(i + 1)}. ${s}`)
				.join("\n")

			const content = await chatCompletion([
				{ role: "system", content: PLAN_SYSTEM_PROMPT },
				{ role: "user", content: userMessage },
			])

			return parsePlanResponse(content)
		},

		async expandStep(
			step: string,
			pageState: PageState,
			page: Page,
		): Promise<PlannedStep[]> {
			const tree = formatA11yTree(pageState.a11yTree)
			const formFields = await captureFormFields(page)
			const formFieldsText = formatFormFields(formFields)

			if (globals.debug) {
				console.log(
					`\n      [expand] Detected ${String(formFields.length)} form fields:`,
				)
				for (const f of formFields) {
					const parts: string[] = [`        <${f.tag}>`]
					if (f.label) parts.push(`label="${f.label}"`)
					if (f.placeholder) parts.push(`placeholder="${f.placeholder}"`)
					parts.push(`type="${f.inputType}"`)
					if (f.required) parts.push("[required]")
					if (f.autocomplete) parts.push("[autocomplete]")
					if (f.options && f.options.length > 0) {
						parts.push(
							`options: [${f.options
								.slice(0, 5)
								.map((o) => `"${o}"`)
								.join(", ")}${f.options.length > 5 ? ", ..." : ""}]`,
						)
					}
					console.log(parts.join(" "))
				}
				const autoFields = formFields.filter((f) => f.autocomplete)
				if (autoFields.length > 0) {
					console.log(
						`      [expand] ${String(autoFields.length)} autocomplete field(s) detected`,
					)
				}
			}

			const userMessage = [
				`Original step: ${step}`,
				"",
				`Current URL: ${pageState.url}`,
				`Page title: ${pageState.title}`,
				"",
				"Accessibility tree:",
				tree,
				"",
				"Form fields on the page (with label, placeholder, type, and options):",
				formFieldsText,
			].join("\n")

			if (globals.debug) {
				console.log(`      [expand] Sending expansion request to LLM...`)
			}

			const content = await chatCompletion([
				{ role: "system", content: EXPAND_SYSTEM_PROMPT },
				{ role: "user", content: userMessage },
			])

			if (globals.debug) {
				console.log(`      [expand] LLM raw response:`)
				for (const line of content.trim().split("\n")) {
					console.log(`        ${line}`)
				}
			}

			const expanded = parsePlanResponse(content)

			if (globals.debug) {
				console.log(
					`      [expand] Parsed into ${String(expanded.length)} sub-steps:`,
				)
				for (const es of expanded) {
					const label = es.action ? JSON.stringify(es.action) : "(needs page)"
					console.log(`        - ${es.step} → ${label}`)
				}
			}

			// Add expansion exchange to history for context in subsequent steps
			history.push(
				{
					role: "user",
					content: `Expanded step: ${step}\nResult:\n${content}`,
				},
				{
					role: "assistant",
					content: "OK, form has been filled and submitted.",
				},
			)

			return expanded
		},

		async resolveStep(step: string, pageState: PageState): Promise<Action> {
			// Check cache: same step on same page → same action
			const cacheKey = `${step}\0${pageState.url}`
			const cached = cache.get(cacheKey)
			if (cached) return cached

			// Try to build a compact message if we have prior state.
			// Three modes:
			//   "unchanged" — page identical, skip tree + visible text
			//   "tree-only" — tree changed, skip visible text
			//   full — first step or after navigation
			let userMessage: string
			let compactMode: string = "full"
			if (prevPageState && history.length > 0) {
				const compact = buildCompactMessage(
					step,
					pageState,
					prevPageState,
					prevFormattedTree,
				)
				if (compact) {
					userMessage = compact.message
					compactMode = compact.mode
				} else {
					userMessage = buildUserMessage(step, pageState)
				}
			} else {
				userMessage = buildUserMessage(step, pageState)
			}

			if (globals.debug) {
				console.log(
					`      [resolve] Mode: ${compactMode} (${String(userMessage.length)} chars)`,
				)
			}

			// Build messages: system + history + new user message
			const messages: ChatMessage[] = [
				{ role: "system", content: SYSTEM_PROMPT },
				...history,
				{ role: "user", content: userMessage },
			]

			const content = await chatCompletion(messages)
			const action = parseActionResponse(content)

			// Cache the result for identical future requests
			cache.set(cacheKey, action)

			// Append this exchange to history for subsequent steps
			history.push(
				{ role: "user", content: userMessage },
				{ role: "assistant", content: content },
			)

			// Track page state for compact messages on subsequent steps
			prevPageState = pageState
			prevFormattedTree = formatA11yTree(pageState.a11yTree)

			return action
		},
	}
}

/**
 * Parse a single action token from the plan response line format.
 * Returns the action (or null for PAGE) and an optional description.
 */
function parsePlanAction(token: string): {
	action: Action | null
	description?: string
	needsExpansion?: boolean
} {
	const t = token.trim()

	// EXPAND "description" — compound step needing runtime expansion
	if (/^expand(?:\s|$)/i.test(t)) {
		const after = t.slice(6).trim()
		const description = after.replace(/^"(.*)"$/, "$1") || undefined
		return { action: null, description, needsExpansion: true }
	}

	// PAGE "description", PAGE description, or bare PAGE
	if (/^page(?:\s|$)/i.test(t)) {
		const after = t.slice(4).trim()
		// Strip surrounding quotes if present
		const description = after.replace(/^"(.*)"$/, "$1") || undefined
		return { action: null, description }
	}

	// assert <type> "<expected>"
	const assertMatch = /^assert\s+(\S+)\s+"([^"]*)"$/i.exec(t)
	if (assertMatch) {
		return {
			action: {
				action: "assert",
				assertion: { type: assertMatch[1], expected: assertMatch[2] },
			},
		}
	}

	// navigate "<url>"
	const navMatch = /^navigate\s+"([^"]*)"$/i.exec(t)
	if (navMatch) {
		return { action: { action: "navigate", value: navMatch[1] } }
	}

	// press "<key>"
	const pressMatch = /^press\s+"([^"]*)"$/i.exec(t)
	if (pressMatch) {
		return { action: { action: "press", value: pressMatch[1] } }
	}

	// scroll "<direction>"
	const scrollMatch = /^scroll\s+"([^"]*)"$/i.exec(t)
	if (scrollMatch) {
		return { action: { action: "scroll", value: scrollMatch[1].toLowerCase() } }
	}

	// Unknown token — treat as page-dependent
	return { action: null }
}

/**
 * Parse the planning LLM response (line-based format) into a flat list of PlannedSteps.
 * One line per action — compound input steps produce multiple lines.
 */
export function parsePlanResponse(raw: string): PlannedStep[] {
	return raw
		.trim()
		.split("\n")
		.filter((l) => l.trim().length > 0)
		.map((line) => {
			const { action, description, needsExpansion } = parsePlanAction(line)
			const step = description ?? line.trim()
			return {
				step,
				action,
				...(needsExpansion ? { needsExpansion: true } : {}),
			}
		})
}
