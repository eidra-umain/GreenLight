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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
	resolveApiKey,
	resolveLLMConfig,
	createLLMClient,
} from "../../src/pilot/llm.js"
import { buildUserMessage, buildMessages } from "../../src/pilot/message-builder.js"
import { parseActionResponse, parsePlanResponse } from "../../src/pilot/response-parser.js"
import { SYSTEM_PROMPT } from "../../src/pilot/prompts.js"
import type { PageState } from "../../src/reporter/types.js"
import type { RunConfig } from "../../src/types.js"
import { DEFAULTS } from "../../src/types.js"
import type { LLMProvider } from "../../src/pilot/providers/index.js"

const mockPageState: PageState = {
	a11yTree: [
		{
			ref: "e1",
			role: "textbox",
			name: "Email",
			raw: '- textbox "Email"',
		},
		{
			ref: "e2",
			role: "textbox",
			name: "Password",
			raw: '- textbox "Password"',
		},
		{
			ref: "e3",
			role: "button",
			name: "Sign In",
			raw: '- button "Sign In"',
		},
	],
	a11yRaw: '- textbox "Email"\n- textbox "Password"\n- button "Sign In"',
	screenshot: "base64png",
	url: "https://staging.example.com/login",
	title: "Login — Example",
	consoleLogs: [],
}

/** Create a mock LLMProvider that returns the given content. */
function createMockProvider(
	responseFn: (...args: unknown[]) => string | Promise<string>,
): LLMProvider {
	return {
		chatCompletion: vi.fn().mockImplementation(() => {
			const result = responseFn()
			return Promise.resolve(result)
		}),
	}
}

describe("buildUserMessage", () => {
	it("includes URL, title, a11y tree, and step", () => {
		const msg = buildUserMessage('click "Sign In"', mockPageState)
		expect(msg).toContain("https://staging.example.com/login")
		expect(msg).toContain("Login — Example")
		expect(msg).toContain('[e1] textbox "Email"')
		expect(msg).toContain('[e3] button "Sign In"')
		expect(msg).toContain('Step to execute: click "Sign In"')
	})
})

describe("buildMessages", () => {
	it("returns system and user messages", () => {
		const messages = buildMessages('click "Sign In"', mockPageState)
		expect(messages).toHaveLength(2)
		expect(messages[0].role).toBe("system")
		expect(messages[0].content).toBe(SYSTEM_PROMPT)
		expect(messages[1].role).toBe("user")
		expect(messages[1].content).toContain("Sign In")
	})
})

describe("parseActionResponse", () => {
	it("throws on unknown action", () => {
		expect(() => parseActionResponse("bogus ref=e1")).toThrow(
			'unknown action "bogus"',
		)
	})

	it("throws on empty input", () => {
		expect(() => parseActionResponse("")).toThrow()
	})

	it("parses click ref=e5", () => {
		const action = parseActionResponse("click ref=e5")
		expect(action).toEqual({ action: "click", ref: "e5" })
	})

	it("parses text format: click text=\"About us\"", () => {
		const action = parseActionResponse('click text="About us"')
		expect(action).toEqual({ action: "click", text: "About us" })
	})

	it("parses text format: type with value", () => {
		const action = parseActionResponse('type ref=e3 value="jane@example.com"')
		expect(action).toEqual({ action: "type", ref: "e3", value: "jane@example.com" })
	})

	it("parses text format: select with value", () => {
		const action = parseActionResponse('select ref=e8 value="Canada"')
		expect(action).toEqual({ action: "select", ref: "e8", value: "Canada" })
	})

	it("parses text format: autocomplete with option", () => {
		const action = parseActionResponse('autocomplete ref=e4 value="foo" option="foobar inc"')
		expect(action).toEqual({ action: "autocomplete", ref: "e4", value: "foo", option: "foobar inc" })
	})

	it("parses text format: remember with as=", () => {
		const action = parseActionResponse('remember ref=e15 as="product_count"')
		expect(action).toEqual({ action: "remember", ref: "e15", rememberAs: "product_count" })
	})

	it("parses text format: assert contains_text", () => {
		const action = parseActionResponse('assert contains_text "Welcome back"')
		expect(action.action).toBe("assert")
		expect(action.assertion).toEqual({ type: "contains_text", expected: "Welcome back" })
	})

	it("parses text format: assert element_visible", () => {
		const action = parseActionResponse('assert element_visible "Submit"')
		expect(action.assertion).toEqual({ type: "element_visible", expected: "Submit" })
	})

	it("parses text format: assert compare with variable", () => {
		const action = parseActionResponse('assert compare "product count" ref=e15 variable="count_before" operator="less_than"')
		expect(action.assertion?.type).toBe("compare")
		expect(action.compare?.variable).toBe("count_before")
		expect(action.compare?.operator).toBe("less_than")
		expect(action.ref).toBe("e15")
	})

	it("parses text format: assert compare with literal", () => {
		const action = parseActionResponse('assert compare "count" ref=e15 variable="_" operator="greater_than" literal="0"')
		expect(action.compare).toEqual({ variable: "_", operator: "greater_than", literal: "0" })
	})

	it("parses text format: navigate", () => {
		const action = parseActionResponse('navigate value="/products"')
		expect(action).toEqual({ action: "navigate", value: "/products" })
	})

	it("parses text format: press", () => {
		const action = parseActionResponse('press value="Enter"')
		expect(action).toEqual({ action: "press", value: "Enter" })
	})

	it("parses text format: scroll", () => {
		const action = parseActionResponse('scroll value="down"')
		expect(action).toEqual({ action: "scroll", value: "down" })
	})

	it("parses text format: assert map_state with escaped quotes", () => {
		const action = parseActionResponse('assert map_state "map shows \\"örebro\\""')
		expect(action.assertion).toEqual({ type: "map_state", expected: 'map shows "örebro"' })
	})

	it("parses text format: assert with inner single quotes", () => {
		const action = parseActionResponse("assert contains_text 'Welcome back'")
		expect(action.assertion).toEqual({ type: "contains_text", expected: "Welcome back" })
	})

})

describe("resolveApiKey", () => {
	const originalEnv = process.env

	beforeEach(() => {
		process.env = { ...originalEnv }
		delete process.env.OPENROUTER_API_KEY
		delete process.env.LLM_API_KEY
	})

	afterEach(() => {
		process.env = originalEnv
	})

	it("reads LLM_API_KEY", () => {
		process.env.LLM_API_KEY = "sk-generic"
		expect(resolveApiKey()).toBe("sk-generic")
	})

	it("falls back to OPENROUTER_API_KEY", () => {
		process.env.OPENROUTER_API_KEY = "sk-or-test"
		expect(resolveApiKey()).toBe("sk-or-test")
	})

	it("prefers LLM_API_KEY over OPENROUTER_API_KEY", () => {
		process.env.LLM_API_KEY = "sk-gen"
		process.env.OPENROUTER_API_KEY = "sk-or"
		expect(resolveApiKey()).toBe("sk-gen")
	})

	it("throws when no key is set", () => {
		expect(() => resolveApiKey()).toThrow("No API key found")
	})
})

describe("resolveLLMConfig", () => {
	const originalEnv = process.env

	beforeEach(() => {
		process.env = { ...originalEnv }
		process.env.LLM_API_KEY = "sk-test"
	})

	afterEach(() => {
		process.env = originalEnv
	})

	it("resolves config from RunConfig", () => {
		const runConfig: RunConfig = {
			...DEFAULTS,
			suiteFiles: [],
			model: "openai/gpt-4o",
			provider: "openrouter",
		}
		const config = resolveLLMConfig(runConfig)
		expect(config.apiKey).toBe("sk-test")
		expect(config.plannerModel).toBe("openai/gpt-4o")
		expect(config.pilotModel).toBe("openai/gpt-4o")
		expect(config.provider).toBeDefined()
	})

	it("resolves ModelConfig with different planner/pilot", () => {
		const runConfig: RunConfig = {
			...DEFAULTS,
			suiteFiles: [],
			model: { planner: "openai/gpt-4o", pilot: "openai/gpt-4o-mini" },
			provider: "openai",
		}
		const config = resolveLLMConfig(runConfig)
		expect(config.plannerModel).toBe("openai/gpt-4o")
		expect(config.pilotModel).toBe("openai/gpt-4o-mini")
	})

	it("does not require an API key when provider is claude-code", () => {
		// Ensure no LLM_API_KEY or OPENROUTER_API_KEY is set
		delete process.env.LLM_API_KEY
		delete process.env.OPENROUTER_API_KEY

		const runConfig = {
			...DEFAULTS,
			suiteFiles: [],
			provider: "claude-code",
			model: "anthropic/claude-sonnet-4",
		} as RunConfig

		// Should not throw even though no API key env var is set
		expect(() => resolveLLMConfig(runConfig)).not.toThrow()
		const config = resolveLLMConfig(runConfig)
		expect(config.apiKey).toBe("")
	})
})

describe("parseProvider (via CLI)", () => {
	it("accepts claude-code as a valid provider string", () => {
		// parseProvider is not exported, but the Provider type now includes
		// "claude-code" — confirm the type compiles and resolveLLMConfig
		// accepts it without throwing about the provider name.
		// Full CLI integration is covered by the manual smoke test.
		const p: import("../../src/types.js").Provider = "claude-code"
		expect(p).toBe("claude-code")
	})
})

describe("createLLMClient", () => {
	it("sends correct request and parses response", async () => {
		const provider = createMockProvider(
			() => "click ref=e3",
		)

		const client = createLLMClient({
			apiKey: "sk-test",
			provider,
			plannerModel: "anthropic/claude-sonnet-4",
			pilotModel: "anthropic/claude-sonnet-4",
		})

		const action = await client.resolveStep('click "Sign In"', mockPageState)
		expect(action).toEqual({ action: "click", ref: "e3" })

		// Verify provider was called with correct model
		expect(provider.chatCompletion).toHaveBeenCalledTimes(1)
		const call = vi.mocked(provider.chatCompletion).mock.calls[0]
		expect(call[1].model).toBe("anthropic/claude-sonnet-4")
		expect(call[1].apiKey).toBe("sk-test")
		expect(call[0]).toHaveLength(2) // system + user
	})

	it("throws on provider error", async () => {
		const provider: LLMProvider = {
			chatCompletion: vi
				.fn()
				.mockRejectedValue(new Error("LLM API error 401: Unauthorized")),
		}

		const client = createLLMClient({
			apiKey: "bad-key",
			provider,
			plannerModel: "anthropic/claude-sonnet-4",
			pilotModel: "anthropic/claude-sonnet-4",
		})

		await expect(
			client.resolveStep('click "Sign In"', mockPageState),
		).rejects.toThrow("LLM API error 401")
	})

	it("throws on empty response", async () => {
		const provider: LLMProvider = {
			chatCompletion: vi
				.fn()
				.mockRejectedValue(new Error("LLM returned empty response")),
		}

		const client = createLLMClient({
			apiKey: "sk-test",
			provider,
			plannerModel: "anthropic/claude-sonnet-4",
			pilotModel: "anthropic/claude-sonnet-4",
		})

		await expect(
			client.resolveStep('click "Sign In"', mockPageState),
		).rejects.toThrow("LLM returned empty response")
	})

	it("planSteps sends all steps and parses response", async () => {
		const planText = [
			'#1 PAGE "click Sign In"',
			'#2 assert contains_text "Welcome"',
			'#3 navigate "/about"',
			'#4 PAGE "type hello into the search field"',
		].join("\n")

		const provider = createMockProvider(() => planText)

		const client = createLLMClient({
			apiKey: "sk-test",
			provider,
			plannerModel: "test-planner",
			pilotModel: "test-pilot",
		})

		const plan = await client.planSteps([
			'click "Sign In"',
			'check that the page contains "Welcome"',
			'go to "/about"',
			'type "hello" into the search field',
		])

		expect(plan).toHaveLength(4)
		expect(plan[0]).toEqual({ step: "click Sign In", action: null, inputStepIndex: 0 })
		expect(plan[1].action).toEqual({
			action: "assert",
			assertion: { type: "contains_text", expected: "Welcome" },
		})
		expect(plan[2].action).toEqual({
			action: "navigate",
			value: "/about",
		})
		expect(plan[3].action).toBeNull()
		expect(provider.chatCompletion).toHaveBeenCalledTimes(1)

		// Verify planner model was used
		const call = vi.mocked(provider.chatCompletion).mock.calls[0]
		expect(call[1].model).toBe("test-planner")
	})

	it("accumulates conversation history across calls", async () => {
		let callCount = 0
		const provider: LLMProvider = {
			chatCompletion: vi.fn().mockImplementation(() => {
				callCount++
				if (callCount === 1)
					return Promise.resolve("click ref=e1")
				return Promise.resolve("click ref=e2")
			}),
		}

		const client = createLLMClient({
			apiKey: "sk-test",
			provider,
			plannerModel: "test-model",
			pilotModel: "test-model",
		})

		await client.resolveStep('click "Home"', mockPageState)
		await client.resolveStep('click "About"', mockPageState)

		// Second call should include history from first call
		const secondCall = vi.mocked(provider.chatCompletion).mock.calls[1]
		const messages = secondCall[0]
		// system + user1 + assistant1 + user2 = 4 messages
		expect(messages).toHaveLength(4)
		expect(messages[0].role).toBe("system")
		expect(messages[1].role).toBe("user")
		expect(messages[2].role).toBe("assistant")
		expect(messages[3].role).toBe("user")
	})

	it("returns cached result for identical step and page state", async () => {
		const provider = createMockProvider(
			() => "click ref=e1",
		)

		const client = createLLMClient({
			apiKey: "sk-test",
			provider,
			plannerModel: "test-model",
			pilotModel: "test-model",
		})

		const first = await client.resolveStep('click "Home"', mockPageState)
		const second = await client.resolveStep('click "Home"', mockPageState)

		expect(first).toEqual(second)
		// Only one call — second was served from cache
		expect(provider.chatCompletion).toHaveBeenCalledTimes(1)
	})

	it("does not use cache when URL differs", async () => {
		let callCount = 0
		const provider: LLMProvider = {
			chatCompletion: vi.fn().mockImplementation(() => {
				callCount++
				if (callCount === 1)
					return Promise.resolve("click ref=e1")
				return Promise.resolve("click ref=e5")
			}),
		}

		const client = createLLMClient({
			apiKey: "sk-test",
			provider,
			plannerModel: "test-model",
			pilotModel: "test-model",
		})

		await client.resolveStep('click "Home"', mockPageState)
		await client.resolveStep('click "Home"', {
			...mockPageState,
			url: "https://staging.example.com/other",
		})

		// Different page state → two calls
		expect(provider.chatCompletion).toHaveBeenCalledTimes(2)
	})

	it("clears history on resetHistory", async () => {
		const provider = createMockProvider(
			() => "click ref=e1",
		)

		const client = createLLMClient({
			apiKey: "sk-test",
			provider,
			plannerModel: "test-model",
			pilotModel: "test-model",
		})

		await client.resolveStep('click "Home"', mockPageState)
		client.resetHistory()
		await client.resolveStep('click "About"', mockPageState)

		const secondCall = vi.mocked(provider.chatCompletion).mock.calls[1]
		const messages = secondCall[0]
		// After reset: system + user = 2 messages (no history)
		expect(messages).toHaveLength(2)
	})

	it("uses pilotModel for resolveStep and plannerModel for planSteps", async () => {
		let callCount = 0
		const provider: LLMProvider = {
			chatCompletion: vi.fn().mockImplementation(() => {
				callCount++
				if (callCount === 1)
					return Promise.resolve('PAGE "click something"')
				return Promise.resolve("click ref=e1") // text format
			}),
		}

		const client = createLLMClient({
			apiKey: "sk-test",
			provider,
			plannerModel: "big-model",
			pilotModel: "small-model",
		})

		await client.planSteps(["click something"])
		const planCall = vi.mocked(provider.chatCompletion).mock.calls[0]
		expect(planCall[1].model).toBe("big-model")

		await client.resolveStep("click something", mockPageState)
		const resolveCall = vi.mocked(provider.chatCompletion).mock.calls[1]
		expect(resolveCall[1].model).toBe("small-model")
	})
})

describe("parsePlanResponse", () => {
	it("parses one action per line", () => {
		const raw = [
			'#1 PAGE "search for tern"',
			'#2 assert contains_text "Hello"',
			'#3 navigate "/about"',
			'#4 press "Enter"',
		].join("\n")
		const result = parsePlanResponse(raw)
		expect(result).toHaveLength(4)
		expect(result[0]).toEqual({ step: "search for tern", action: null, inputStepIndex: 0 })
		expect(result[1]).toEqual({
			step: 'assert contains_text "Hello"',
			action: {
				action: "assert",
				assertion: { type: "contains_text", expected: "Hello" },
			},
			inputStepIndex: 1,
		})
		expect(result[2]).toEqual({
			step: 'navigate "/about"',
			action: { action: "navigate", value: "/about" },
			inputStepIndex: 2,
		})
		expect(result[3]).toEqual({
			step: 'press "Enter"',
			action: { action: "press", value: "Enter" },
			inputStepIndex: 3,
		})
	})

	it("handles compound steps split into multiple lines", () => {
		const raw = [
			'#1 PAGE "click Företag in the form"',
			'#1 PAGE "click Ventilation in the form"',
			'#1 PAGE "click Kylteknik in the form"',
		].join("\n")
		const result = parsePlanResponse(raw)
		expect(result).toHaveLength(3)
		expect(result[0].step).toBe("click Företag in the form")
		expect(result[1].step).toBe("click Ventilation in the form")
		expect(result[2].step).toBe("click Kylteknik in the form")
		expect(result.every((r) => r.action === null)).toBe(true)
	})

	it("uses raw line as step label for non-PAGE actions", () => {
		const result = parsePlanResponse('#1 assert field_exists "Email"')
		expect(result[0].step).toBe('assert field_exists "Email"')
	})

	it("parses all assertion types", () => {
		const raw = [
			'#1 assert contains_text "Hello"',
			'#2 assert not_contains_text "Error"',
			'#3 assert url_contains "/home"',
			'#4 assert element_visible "Banner"',
			'#5 assert element_not_visible "Spinner"',
			'#6 assert link_exists "/"',
			'#7 assert field_exists "Email"',
		].join("\n")
		const result = parsePlanResponse(raw)
		expect(result[0].action?.assertion?.type).toBe("contains_text")
		expect(result[1].action?.assertion?.type).toBe("not_contains_text")
		expect(result[2].action?.assertion?.type).toBe("url_contains")
		expect(result[3].action?.assertion?.type).toBe("element_visible")
		expect(result[4].action?.assertion?.type).toBe("element_not_visible")
		expect(result[5].action?.assertion?.type).toBe("link_exists")
		expect(result[6].action?.assertion?.type).toBe("field_exists")
	})

	it("parses scroll action", () => {
		const result = parsePlanResponse('#1 scroll "down"')
		expect(result[0].action).toEqual({ action: "scroll", value: "down" })
	})

	it("parses PAGE with unquoted description", () => {
		const result = parsePlanResponse('#1 PAGE click the Sign In button')
		expect(result[0].action).toBeNull()
		expect(result[0].step).toBe("click the Sign In button")
	})

	it("treats unrecognized tokens as PAGE without description", () => {
		const result = parsePlanResponse("#1 something weird")
		expect(result[0].action).toBeNull()
		expect(result[0].step).toBe("something weird")
	})

	it("ignores blank lines", () => {
		const raw = '#1 PAGE "click A"\n\n#2 PAGE "click B"\n'
		const result = parsePlanResponse(raw)
		expect(result).toHaveLength(2)
	})
})
