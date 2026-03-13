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

/** The LLM client interface. */
export interface LLMClient {
	resolveStep(step: string, pageState: PageState): Promise<Action>
}

/** System prompt that defines the Pilot's persona and expected response format. */
export const SYSTEM_PROMPT = `You are The Pilot, an AI agent that executes end-to-end tests in a web browser.

You receive a plain-English test step and the current page state (an accessibility tree with element refs).

Your job is to determine the SINGLE browser action needed to execute the step.

Available actions:
- click: Click an element. Requires "ref".
- type: Type text into an input. Requires "ref" and "value".
- select: Select an option from a dropdown. Requires "ref" and "value" (the option label).
- scroll: Scroll the page. Requires "value" ("up" or "down"). Optional "ref" to scroll a specific element.
- navigate: Navigate to a URL. Requires "value" (the URL or path).
- press: Press a keyboard key. Requires "value" (key name, e.g. "Enter", "Tab", "Escape").
- wait: Wait for a condition. Requires "value" (description of what to wait for).
- assert: Check a condition on the page. Requires "assertion" with "type" and "expected".
  Assertion types: "contains_text", "url_contains", "element_visible", "element_not_visible".

Respond with ONLY a JSON object. No markdown, no explanation. Example responses:

{"action":"click","ref":"e5"}
{"action":"type","ref":"e3","value":"jane@example.com"}
{"action":"select","ref":"e8","value":"Canada"}
{"action":"navigate","value":"/products"}
{"action":"press","value":"Enter"}
{"action":"assert","assertion":{"type":"contains_text","expected":"Welcome back"}}
{"action":"scroll","value":"down"}
`

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

/** Create an LLM client that calls the OpenAI-compatible chat completions endpoint. */
export function createLLMClient(config: LLMClientConfig): LLMClient {
	const endpoint = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`

	return {
		async resolveStep(step: string, pageState: PageState): Promise<Action> {
			const messages = buildMessages(step, pageState)

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

			return parseActionResponse(content)
		},
	}
}
