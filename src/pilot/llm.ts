/**
 * Provider-agnostic LLM client.
 * Uses pluggable providers for chat completions.
 */

import type { RunConfig } from "../types.js"
import { resolveModelConfig } from "../types.js"
import type { Action, PageState } from "../reporter/types.js"
import { formatA11yTree } from "./a11y-parser.js"
import { captureFormFields, formatFormFields } from "./form-fields.js"
import type { Page } from "playwright"
import { globals } from "../globals.js"

import {
	SYSTEM_PROMPT,
	PLAN_SYSTEM_PROMPT,
	EXPAND_SYSTEM_PROMPT,
} from "./prompts.js"
import { buildUserMessage, buildCompactMessage, formatLocalTime } from "./message-builder.js"
import { parseActionResponse, parsePlanResponse } from "./response-parser.js"
import type { PlannedStep } from "./response-parser.js"
import type { ChatMessage, LLMProvider } from "./providers/index.js"
import { createProvider, LLMApiError } from "./providers/index.js"

/** Re-export ChatMessage so existing imports still work. */
export type { ChatMessage } from "./providers/index.js"

/** Configuration for the LLM client. */
export interface LLMClientConfig {
	apiKey: string
	provider: LLMProvider
	plannerModel: string
	pilotModel: string
}

/** The LLM client interface. */
export interface LLMClient {
	/**
	 * Pre-plan all steps by sending the full test spec to the LLM.
	 * The LLM interprets each step, potentially splitting compound steps
	 * into multiple atomic actions. Returns a flat list of planned steps.
	 */
	planSteps(steps: string[]): Promise<PlannedStep[]>
	/** Evaluate a condition against the live page state. Returns true/false. */
	evaluateCondition(
		condition: string,
		conditionType: string,
		pageState: PageState,
	): Promise<boolean>
	/** Resolve a single step using the page state and a11y tree. */
	resolveStep(step: string, pageState: PageState): Promise<Action>
	/**
	 * Resolve a step using the planner model (more capable, higher cost).
	 * Used as a fallback when the pilot model fails to resolve a step.
	 * Returns null if the planner and pilot use the same model.
	 */
	resolveStepWithPlanner(step: string, pageState: PageState): Promise<Action | null>
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

/** Resolve the API key from environment variables. */
export function resolveApiKey(): string {
	const key = process.env.LLM_API_KEY ?? process.env.OPENROUTER_API_KEY
	if (!key) {
		throw new Error(
			"No API key found. Set LLM_API_KEY or OPENROUTER_API_KEY environment variable.",
		)
	}
	return key
}

/** Resolve LLM client config from RunConfig and environment. */
export function resolveLLMConfig(runConfig: RunConfig): LLMClientConfig {
	const modelConfig = resolveModelConfig(runConfig.model)
	const provider = createProvider(runConfig.provider, runConfig.llmBaseUrl)
	return {
		apiKey: resolveApiKey(),
		provider,
		plannerModel: modelConfig.planner,
		pilotModel: modelConfig.pilot,
	}
}

/**
 * Create an LLM client that maintains conversation history within a test case.
 * The system prompt is sent once. Each step adds a user message and the LLM's
 * response to the history, giving the model context about prior actions.
 * Call resetHistory() between test cases.
 */
export function createLLMClient(config: LLMClientConfig): LLMClient {
	let history: ChatMessage[] = []
	const cache = new Map<string, Action>()
	let prevPageState: PageState | null = null
	let prevFormattedTree = ""

	async function chat(messages: ChatMessage[], model: string): Promise<string> {
		return config.provider.chatCompletion(messages, {
			apiKey: config.apiKey,
			model,
		})
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

			const content = await chat(
				[
					{ role: "system", content: PLAN_SYSTEM_PROMPT },
					{ role: "user", content: userMessage },
				],
				config.plannerModel,
			)

			return parsePlanResponse(content)
		},

		async evaluateCondition(
			condition: string,
			_conditionType: string,
			pageState: PageState,
		): Promise<boolean> {
			// Frame condition as a regular assertion step so it participates
			// in the same conversation (SYSTEM_PROMPT + history + compact diffs).
			// The model returns JSON in its normal format; we interpret the
			// assertion type to determine true/false.
			const step = `check if there is a visible, prominent element matching "${condition}" on the page — a button, link, input, or heading that a user would see and interact with. Ignore hidden "skip to content" links and other accessibility-only elements. Partial name matching is OK (e.g. "password" matches "Enter visitor password"). If no such prominent element exists, respond with element_not_visible.`

			let userMessage: string
			let compactMode = "full"
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
				console.log(`      [condition] Mode: ${compactMode} (${String(userMessage.length)} chars)`)
				console.log(`      [condition] LLM input:\n${userMessage}`)
			}

			const messages: ChatMessage[] = [
				{ role: "system", content: SYSTEM_PROMPT },
				...history,
				{ role: "user", content: userMessage },
			]

			const content = await chat(messages, config.pilotModel)

			if (globals.debug) {
				console.log(`      [condition] LLM response: ${content.trim()}`)
			}

			// Interpret the response: if the model returned a positive
			// assertion (element_visible, element_exists, contains_text)
			// or found a ref/text target, the condition is met.
			let result = false
			try {
				const action = parseActionResponse(content)
				if (action.assertion) {
					const t = action.assertion.type
					result = !t.startsWith("not_") && t !== "element_not_visible"
				} else if (action.ref || action.text) {
					// Model found an element to interact with → it exists
					result = true
				}
			} catch {
				// Parse failed — model couldn't make sense of condition → false
			}

			// Add to history and update state tracking
			history.push(
				{ role: "user", content: userMessage },
				{ role: "assistant", content },
			)
			prevPageState = pageState
			prevFormattedTree = formatA11yTree(pageState.a11yTree)

			return result
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

			const content = await chat(
				[
					{ role: "system", content: EXPAND_SYSTEM_PROMPT },
					{ role: "user", content: userMessage },
				],
				config.plannerModel,
			)

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
			let compactMode = "full"
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
				console.log(`      [resolve] LLM input:\n${userMessage}`)
			}

			// Build messages: system + history + new user message.
			// Prune oldest history pairs if total would exceed token budget.
			const TOKEN_BUDGET = 100_000
			const CHARS_PER_TOKEN = 4
			const systemTokens = Math.ceil(SYSTEM_PROMPT.length / CHARS_PER_TOKEN)
			const userTokens = Math.ceil(userMessage.length / CHARS_PER_TOKEN)
			let historySlice = history
			let totalTokens = systemTokens + userTokens
			for (const msg of history) {
				totalTokens += Math.ceil(msg.content.length / CHARS_PER_TOKEN)
			}
			if (totalTokens > TOKEN_BUDGET) {
				// Drop oldest pairs from history until within budget
				historySlice = [...history]
				while (historySlice.length >= 2 && totalTokens > TOKEN_BUDGET) {
					const dropped1 = historySlice.shift()!
					const dropped2 = historySlice.shift()!
					totalTokens -= Math.ceil(dropped1.content.length / CHARS_PER_TOKEN)
					totalTokens -= Math.ceil(dropped2.content.length / CHARS_PER_TOKEN)
				}
				if (globals.debug) {
					console.log(`      [resolve] Pruned history: ${String(history.length)} → ${String(historySlice.length)} messages (~${String(Math.round(totalTokens))} tokens)`)
				}
			}

			const messages: ChatMessage[] = [
				{ role: "system", content: SYSTEM_PROMPT },
				...historySlice,
				{ role: "user", content: userMessage },
			]

			let content: string
			try {
				content = await chat(messages, config.pilotModel)
			} catch (err) {
				// If context length exceeded, clear history and retry with just
				// system + current message (fresh context).
				if (err instanceof LLMApiError && /context.length|token/i.test(err.message)) {
					console.log(`      ⚠ Context length exceeded — clearing history and retrying`)
					history.length = 0
					prevPageState = null
					prevFormattedTree = ""

					// Rebuild as a full message (no compact mode without prior state)
					const freshMessage = buildUserMessage(step, pageState)
					const freshMessages: ChatMessage[] = [
						{ role: "system", content: SYSTEM_PROMPT },
						{ role: "user", content: freshMessage },
					]
					content = await chat(freshMessages, config.pilotModel)
					userMessage = freshMessage
				} else {
					throw err
				}
			}

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

		async resolveStepWithPlanner(step: string, pageState: PageState): Promise<Action | null> {
			// No point retrying with the same model
			if (config.plannerModel === config.pilotModel) return null

			// Build a fresh full message (no history — one-shot with the planner)
			const userMessage = buildUserMessage(step, pageState)

			const messages: ChatMessage[] = [
				{ role: "system", content: SYSTEM_PROMPT },
				{ role: "user", content: userMessage },
			]

			const content = await chat(messages, config.plannerModel)
			return parseActionResponse(content)
		},
	}
}
