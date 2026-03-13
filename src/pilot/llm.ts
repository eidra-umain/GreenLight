/**
 * Provider-agnostic LLM client using the OpenAI-compatible chat completions API.
 * Default backend: OpenRouter. Works with any OpenAI-compatible endpoint.
 */

import type { RunConfig } from "../types.js"
import type { Action, PageState } from "../reporter/types.js"
import { formatA11yTree } from "./state.js"

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
	/** Reset conversation history (call between test cases). */
	resetHistory(): void
}

/** System prompt that defines the Pilot's persona and expected response format. */
export const SYSTEM_PROMPT = `You are The Pilot, an AI agent that executes end-to-end tests in a web browser.

You receive a plain-English test step and the current page state (an accessibility tree with element refs).

Your job is to determine the SINGLE browser action needed to execute the step.

Available actions:
- click: Click an element. Requires "ref" or "text".
- type: Type text into an input. Requires "ref" or "text", and "value".
- select: Select an option from a dropdown. Requires "ref" or "text", and "value" (the option label).
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

IMPORTANT: Any step that starts with "check that" is ALWAYS an assertion. Never return a click, type, or other interaction for a "check that" step.

Respond with ONLY a JSON object. No markdown, no explanation. Example responses:

{"action":"click","ref":"e5"}
{"action":"click","text":"Till företaget"}
{"action":"type","ref":"e3","value":"jane@example.com"}
{"action":"select","ref":"e8","value":"Canada"}
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
- IMPORTANT: When a step lists multiple items separated by dashes, commas, or "then", each item is a SEPARATE action and must be output on its own line.
  For example, the input step "Select Red - Green - Blue in the color picker" must produce three lines:
  PAGE "click Red in the color picker"
  PAGE "click Green in the color picker"
  PAGE "click Blue in the color picker"
- No blank lines, no numbering, no explanation. Only action lines.
`

// ── Message construction ────────────────────────────────────────────

/** Build the user message containing the step and page state. */
export function buildUserMessage(step: string, pageState: PageState): string {
	const tree = formatA11yTree(pageState.a11yTree)
	return [
		`Current URL: ${pageState.url}`,
		`Page title: ${pageState.title}`,
		"",
		"Accessibility tree:",
		tree,
		"",
		`Step to execute: ${step}`,
	].join("\n")
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
		"type",
		"select",
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

		async resolveStep(step: string, pageState: PageState): Promise<Action> {
			// Check cache: same step on same page → same action
			const cacheKey = `${step}\0${pageState.url}`
			const cached = cache.get(cacheKey)
			if (cached) return cached

			const userMessage = buildUserMessage(step, pageState)

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
} {
	const t = token.trim()

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
			const { action, description } = parsePlanAction(line)
			const step = description ?? line.trim()
			return { step, action }
		})
}
