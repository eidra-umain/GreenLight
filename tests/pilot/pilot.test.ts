import { describe, it, expect, vi } from "vitest"
import type { Page } from "playwright"
import {
	launchBrowser,
	createContext,
	createPage,
	closeBrowser,
} from "../../src/browser/browser.js"
import { attachConsoleCollector } from "../../src/pilot/network.js"
import { runTestCase } from "../../src/pilot/pilot.js"
import type { LLMClient } from "../../src/pilot/llm.js"
import type { PlannedStep } from "../../src/pilot/response-parser.js"
import type { Action, ConsoleEntry, PageState } from "../../src/reporter/types.js"
import { DEFAULTS } from "../../src/types.js"

const html = `
	<html><body>
		<h1>Test App</h1>
		<input type="text" aria-label="Name" />
		<button onclick="document.getElementById('msg').textContent='Hello, ' + document.querySelector('[aria-label=Name]').value">
			Greet
		</button>
		<p id="msg"></p>
	</body></html>
`

function makeMockLLM(actions: Action[]): LLMClient {
	let callIndex = 0
	return {
		resetHistory: vi.fn(),
		planSteps: vi.fn((steps: string[]): Promise<PlannedStep[]> => {
			// Mock planner returns null for all steps (runtime resolution)
			return Promise.resolve(steps.map((s) => ({ step: s, action: null })))
		}),
		resolveStep: vi.fn((_step: string, _state: PageState) => {
			const action = actions[callIndex]
			callIndex++
			return Promise.resolve(action)
		}),
		expandStep: vi.fn(() => Promise.resolve([])),
	}
}

async function withPage(
	fn: (page: Page, drain: () => ConsoleEntry[]) => Promise<void>,
) {
	const browser = await launchBrowser({
		headed: false,
		viewport: DEFAULTS.viewport,
	})
	const context = await createContext(browser, {
		headed: false,
		viewport: DEFAULTS.viewport,
	})
	const page = await createPage(context)
	const { drain } = attachConsoleCollector(page)
	await page.setContent(html)
	try {
		await fn(page, drain)
	} finally {
		await context.close()
		await closeBrowser(browser)
	}
}

describe("runTestCase", () => {
	it("runs all steps and returns passed", async () => {
		await withPage(async (page, drain) => {
			const llm = makeMockLLM([
				{ action: "type", ref: "e2", value: "World" },
				{ action: "click", ref: "e3" },
				{
					action: "assert",
					assertion: { type: "contains_text", expected: "Hello, World" },
				},
			])

			const result = await runTestCase(
				page,
				{
					name: "Greet test",
					steps: [
						'enter "World" into "Name"',
						'click "Greet"',
						'check that page contains "Hello, World"',
					],
				},
				llm,
				{ timeout: 5000, consoleDrain: drain },
			)

			expect(result.status).toBe("passed")
			expect(result.steps).toHaveLength(3)
			expect(result.steps.every((s) => s.status === "passed")).toBe(true)
			expect(llm.resolveStep).toHaveBeenCalledTimes(3)
		})
	})

	it("fails fast on first failed step", async () => {
		await withPage(async (page, drain) => {
			const llm = makeMockLLM([
				{ action: "click", ref: "e99" }, // bad ref
				{ action: "click", ref: "e3" }, // should not run
			])

			const result = await runTestCase(
				page,
				{
					name: "Fail test",
					steps: ["click something bad", "click Greet"],
				},
				llm,
				{ timeout: 5000, consoleDrain: drain },
			)

			expect(result.status).toBe("failed")
			expect(result.steps).toHaveLength(1)
			expect(result.steps[0].status).toBe("failed")
			expect(result.steps[0].error).toContain("not found")
			expect(llm.resolveStep).toHaveBeenCalledTimes(1)
		})
	})

	it("fails on assertion failure", { timeout: 10000 }, async () => {
		await withPage(async (page, drain) => {
			const llm = makeMockLLM([
				{
					action: "assert",
					assertion: {
						type: "contains_text",
						expected: "Nonexistent",
					},
				},
			])

			const result = await runTestCase(
				page,
				{
					name: "Assert fail",
					steps: ['check that page contains "Nonexistent"'],
				},
				llm,
				{ timeout: 5000, consoleDrain: drain },
			)

			expect(result.status).toBe("failed")
			expect(result.steps[0].error).toContain("does not contain text")
		})
	})

	it("records duration for each step", async () => {
		await withPage(async (page, drain) => {
			const llm = makeMockLLM([{ action: "click", ref: "e3" }])

			const result = await runTestCase(
				page,
				{ name: "Duration test", steps: ['click "Greet"'] },
				llm,
				{ timeout: 5000, consoleDrain: drain },
			)

			expect(result.duration).toBeGreaterThan(0)
			expect(result.steps[0].duration).toBeGreaterThan(0)
		})
	})

	it("captures post-action screenshot on success", async () => {
		await withPage(async (page, drain) => {
			const llm = makeMockLLM([{ action: "click", ref: "e3" }])

			const result = await runTestCase(
				page,
				{ name: "Screenshot test", steps: ['click "Greet"'] },
				llm,
				{ timeout: 5000, consoleDrain: drain, screenshots: true },
			)

			expect(result.steps[0].screenshot).toBeDefined()
			expect(result.steps[0].screenshot?.length).toBeGreaterThan(0)
		})
	})

	it("handles LLM error gracefully", async () => {
		await withPage(async (page, drain) => {
			const llm: LLMClient = {
				resetHistory: vi.fn(),
				planSteps: vi.fn(
					(steps: string[]): Promise<PlannedStep[]> =>
						Promise.resolve(steps.map((s) => ({ step: s, action: null }))),
				),
				resolveStep: vi.fn(() => {
					return Promise.reject(new Error("LLM API error 500: Internal Server Error"))
				}),
				expandStep: vi.fn(() => Promise.resolve([])),
			}

			const result = await runTestCase(
				page,
				{ name: "LLM error test", steps: ["do something"] },
				llm,
				{ timeout: 5000, consoleDrain: drain },
			)

			expect(result.status).toBe("failed")
			expect(result.steps[0].error).toContain("LLM API error")
			expect(result.steps[0].action).toBeNull()
		})
	})
})
