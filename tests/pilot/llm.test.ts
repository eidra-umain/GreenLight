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
	it("parses a click action", () => {
		const action = parseActionResponse('{"action":"click","ref":"e5"}')
		expect(action).toEqual({ action: "click", ref: "e5" })
	})

	it("parses a type action with value", () => {
		const action = parseActionResponse(
			'{"action":"type","ref":"e3","value":"jane@example.com"}',
		)
		expect(action).toEqual({
			action: "type",
			ref: "e3",
			value: "jane@example.com",
		})
	})

	it("parses an assert action with assertion", () => {
		const action = parseActionResponse(
			'{"action":"assert","assertion":{"type":"contains_text","expected":"Welcome"}}',
		)
		expect(action).toEqual({
			action: "assert",
			assertion: { type: "contains_text", expected: "Welcome" },
		})
	})

	it("parses a navigate action", () => {
		const action = parseActionResponse(
			'{"action":"navigate","value":"/products"}',
		)
		expect(action).toEqual({ action: "navigate", value: "/products" })
	})

	it("strips markdown code fences", () => {
		const action = parseActionResponse(
			'```json\n{"action":"click","ref":"e1"}\n```',
		)
		expect(action).toEqual({ action: "click", ref: "e1" })
	})

	it("throws on invalid JSON", () => {
		expect(() => parseActionResponse("not json")).toThrow(
			"LLM returned invalid JSON",
		)
	})

	it("throws on non-object JSON", () => {
		expect(() => parseActionResponse('"hello"')).toThrow(
			"LLM returned non-object JSON",
		)
	})

	it("throws on missing action field", () => {
		expect(() => parseActionResponse('{"ref":"e1"}')).toThrow(
			'missing "action" field',
		)
	})

	it("throws on unknown action type", () => {
		expect(() => parseActionResponse('{"action":"hover","ref":"e1"}')).toThrow(
			'unknown action "hover"',
		)
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

	it("reads OPENROUTER_API_KEY", () => {
		process.env.OPENROUTER_API_KEY = "sk-or-test"
		expect(resolveApiKey()).toBe("sk-or-test")
	})

	it("falls back to LLM_API_KEY", () => {
		process.env.LLM_API_KEY = "sk-generic"
		expect(resolveApiKey()).toBe("sk-generic")
	})

	it("prefers OPENROUTER_API_KEY over LLM_API_KEY", () => {
		process.env.OPENROUTER_API_KEY = "sk-or"
		process.env.LLM_API_KEY = "sk-gen"
		expect(resolveApiKey()).toBe("sk-or")
	})

	it("throws when no key is set", () => {
		expect(() => resolveApiKey()).toThrow("No API key found")
	})
})

describe("resolveLLMConfig", () => {
	const originalEnv = process.env

	beforeEach(() => {
		process.env = { ...originalEnv }
		process.env.OPENROUTER_API_KEY = "sk-test"
	})

	afterEach(() => {
		process.env = originalEnv
	})

	it("resolves config from RunConfig", () => {
		const runConfig: RunConfig = {
			...DEFAULTS,
			suiteFiles: [],
			model: "openai/gpt-4o",
			llmBaseUrl: "https://openrouter.ai/api/v1",
		}
		const config = resolveLLMConfig(runConfig)
		expect(config.apiKey).toBe("sk-test")
		expect(config.model).toBe("openai/gpt-4o")
		expect(config.baseUrl).toBe("https://openrouter.ai/api/v1")
	})
})

describe("createLLMClient", () => {
	const originalFetch = globalThis.fetch

	afterEach(() => {
		globalThis.fetch = originalFetch
	})

	it("sends correct request and parses response", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () =>
				Promise.resolve({
					choices: [
						{
							message: {
								content: '{"action":"click","ref":"e3"}',
							},
						},
					],
				}),
		})

		const client = createLLMClient({
			apiKey: "sk-test",
			baseUrl: "https://openrouter.ai/api/v1",
			model: "anthropic/claude-sonnet-4",
		})

		const action = await client.resolveStep('click "Sign In"', mockPageState)
		expect(action).toEqual({ action: "click", ref: "e3" })

		const fetchCall = vi.mocked(fetch).mock.calls[0]
		expect(fetchCall[0]).toBe("https://openrouter.ai/api/v1/chat/completions")

		const requestInit = fetchCall[1]!
		expect(requestInit.method).toBe("POST")

		const headers = requestInit.headers as Record<string, string>
		expect(headers.Authorization).toBe("Bearer sk-test")

		const body = JSON.parse(requestInit.body as string) as {
			model: string
			messages: { role: string; content: string }[]
			temperature: number
		}
		expect(body.model).toBe("anthropic/claude-sonnet-4")
		expect(body.messages).toHaveLength(2)
		expect(body.temperature).toBe(0)
	})

	it("throws on API error", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 401,
			text: () => Promise.resolve("Unauthorized"),
		})

		const client = createLLMClient({
			apiKey: "bad-key",
			baseUrl: "https://openrouter.ai/api/v1",
			model: "anthropic/claude-sonnet-4",
		})

		await expect(
			client.resolveStep('click "Sign In"', mockPageState),
		).rejects.toThrow("LLM API error 401")
	})

	it("throws on empty response", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ choices: [] }),
		})

		const client = createLLMClient({
			apiKey: "sk-test",
			baseUrl: "https://openrouter.ai/api/v1",
			model: "anthropic/claude-sonnet-4",
		})

		await expect(
			client.resolveStep('click "Sign In"', mockPageState),
		).rejects.toThrow("LLM returned empty response")
	})

	it("strips trailing slash from base URL", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () =>
				Promise.resolve({
					choices: [
						{
							message: {
								content: '{"action":"click","ref":"e1"}',
							},
						},
					],
				}),
		})

		const client = createLLMClient({
			apiKey: "sk-test",
			baseUrl: "https://openrouter.ai/api/v1/",
			model: "test-model",
		})

		await client.resolveStep("click something", mockPageState)

		const fetchCall = vi.mocked(fetch).mock.calls[0]
		expect(fetchCall[0]).toBe("https://openrouter.ai/api/v1/chat/completions")
	})

	it("planSteps sends all steps and parses response", async () => {
		const planText = [
			'PAGE "click Sign In"',
			'assert contains_text "Welcome"',
			'navigate "/about"',
			'PAGE "type hello into the search field"',
		].join("\n")
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () =>
				Promise.resolve({
					choices: [{ message: { content: planText } }],
				}),
		})

		const client = createLLMClient({
			apiKey: "sk-test",
			baseUrl: "https://openrouter.ai/api/v1",
			model: "test-model",
		})

		const plan = await client.planSteps([
			'click "Sign In"',
			'check that the page contains "Welcome"',
			'go to "/about"',
			'type "hello" into the search field',
		])

		expect(plan).toHaveLength(4)
		expect(plan[0]).toEqual({ step: "click Sign In", action: null })
		expect(plan[1].action).toEqual({
			action: "assert",
			assertion: { type: "contains_text", expected: "Welcome" },
		})
		expect(plan[2].action).toEqual({
			action: "navigate",
			value: "/about",
		})
		expect(plan[3].action).toBeNull()
		expect(fetch).toHaveBeenCalledTimes(1)
	})

	it("accumulates conversation history across calls", async () => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValueOnce({
				ok: true,
				json: () =>
					Promise.resolve({
						choices: [
							{ message: { content: '{"action":"click","ref":"e1"}' } },
						],
					}),
			})
			.mockResolvedValueOnce({
				ok: true,
				json: () =>
					Promise.resolve({
						choices: [
							{ message: { content: '{"action":"click","ref":"e2"}' } },
						],
					}),
			})

		const client = createLLMClient({
			apiKey: "sk-test",
			baseUrl: "https://openrouter.ai/api/v1",
			model: "test-model",
		})

		await client.resolveStep('click "Home"', mockPageState)
		await client.resolveStep('click "About"', mockPageState)

		// Second call should include history from first call
		const secondCall = vi.mocked(fetch).mock.calls[1]
		const body = JSON.parse(secondCall[1]?.body as string) as {
			messages: { role: string }[]
		}
		// system + user1 + assistant1 + user2 = 4 messages
		expect(body.messages).toHaveLength(4)
		expect(body.messages[0].role).toBe("system")
		expect(body.messages[1].role).toBe("user")
		expect(body.messages[2].role).toBe("assistant")
		expect(body.messages[3].role).toBe("user")
	})

	it("returns cached result for identical step and page state", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () =>
				Promise.resolve({
					choices: [{ message: { content: '{"action":"click","ref":"e1"}' } }],
				}),
		})

		const client = createLLMClient({
			apiKey: "sk-test",
			baseUrl: "https://openrouter.ai/api/v1",
			model: "test-model",
		})

		const first = await client.resolveStep('click "Home"', mockPageState)
		const second = await client.resolveStep('click "Home"', mockPageState)

		expect(first).toEqual(second)
		// Only one fetch call — second was served from cache
		expect(fetch).toHaveBeenCalledTimes(1)
	})

	it("does not use cache when URL differs", async () => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValueOnce({
				ok: true,
				json: () =>
					Promise.resolve({
						choices: [
							{ message: { content: '{"action":"click","ref":"e1"}' } },
						],
					}),
			})
			.mockResolvedValueOnce({
				ok: true,
				json: () =>
					Promise.resolve({
						choices: [
							{ message: { content: '{"action":"click","ref":"e5"}' } },
						],
					}),
			})

		const client = createLLMClient({
			apiKey: "sk-test",
			baseUrl: "https://openrouter.ai/api/v1",
			model: "test-model",
		})

		await client.resolveStep('click "Home"', mockPageState)
		await client.resolveStep('click "Home"', {
			...mockPageState,
			url: "https://staging.example.com/other",
		})

		// Different page state → two fetch calls
		expect(fetch).toHaveBeenCalledTimes(2)
	})

	it("clears history on resetHistory", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () =>
				Promise.resolve({
					choices: [{ message: { content: '{"action":"click","ref":"e1"}' } }],
				}),
		})

		const client = createLLMClient({
			apiKey: "sk-test",
			baseUrl: "https://openrouter.ai/api/v1",
			model: "test-model",
		})

		await client.resolveStep('click "Home"', mockPageState)
		client.resetHistory()
		await client.resolveStep('click "About"', mockPageState)

		const secondCall = vi.mocked(fetch).mock.calls[1]
		const body = JSON.parse(secondCall[1]?.body as string) as {
			messages: { role: string }[]
		}
		// After reset: system + user = 2 messages (no history)
		expect(body.messages).toHaveLength(2)
	})
})

describe("parsePlanResponse", () => {
	it("parses one action per line", () => {
		const raw = [
			'PAGE "search for tern"',
			'assert contains_text "Hello"',
			'navigate "/about"',
			'press "Enter"',
		].join("\n")
		const result = parsePlanResponse(raw)
		expect(result).toHaveLength(4)
		expect(result[0]).toEqual({ step: "search for tern", action: null })
		expect(result[1]).toEqual({
			step: 'assert contains_text "Hello"',
			action: {
				action: "assert",
				assertion: { type: "contains_text", expected: "Hello" },
			},
		})
		expect(result[2]).toEqual({
			step: 'navigate "/about"',
			action: { action: "navigate", value: "/about" },
		})
		expect(result[3]).toEqual({
			step: 'press "Enter"',
			action: { action: "press", value: "Enter" },
		})
	})

	it("handles compound steps split into multiple lines", () => {
		const raw = [
			'PAGE "click Företag in the form"',
			'PAGE "click Ventilation in the form"',
			'PAGE "click Kylteknik in the form"',
		].join("\n")
		const result = parsePlanResponse(raw)
		expect(result).toHaveLength(3)
		expect(result[0].step).toBe("click Företag in the form")
		expect(result[1].step).toBe("click Ventilation in the form")
		expect(result[2].step).toBe("click Kylteknik in the form")
		expect(result.every((r) => r.action === null)).toBe(true)
	})

	it("uses raw line as step label for non-PAGE actions", () => {
		const result = parsePlanResponse('assert field_exists "Email"')
		expect(result[0].step).toBe('assert field_exists "Email"')
	})

	it("parses all assertion types", () => {
		const raw = [
			'assert contains_text "Hello"',
			'assert not_contains_text "Error"',
			'assert url_contains "/home"',
			'assert element_visible "Banner"',
			'assert element_not_visible "Spinner"',
			'assert link_exists "/"',
			'assert field_exists "Email"',
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
		const result = parsePlanResponse('scroll "down"')
		expect(result[0].action).toEqual({ action: "scroll", value: "down" })
	})

	it("parses PAGE with unquoted description", () => {
		const result = parsePlanResponse('PAGE click the Sign In button')
		expect(result[0].action).toBeNull()
		expect(result[0].step).toBe("click the Sign In button")
	})

	it("treats unrecognized tokens as PAGE without description", () => {
		const result = parsePlanResponse("something weird")
		expect(result[0].action).toBeNull()
		expect(result[0].step).toBe("something weird")
	})

	it("ignores blank lines", () => {
		const raw = 'PAGE "click A"\n\nPAGE "click B"\n'
		const result = parsePlanResponse(raw)
		expect(result).toHaveLength(2)
	})
})
