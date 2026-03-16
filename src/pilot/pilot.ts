/**
 * The Pilot — core AI agent loop.
 * Iterates through test steps: capture state → LLM → execute → record result.
 */

import type { Page } from "playwright"
import type {
	A11yNode,
	Action,
	ConsoleEntry,
	StepResult,
	StepTiming,
	TestCaseResult,
} from "../reporter/types.js"
import type { LLMClient, PlannedStep } from "./llm.js"
import { capturePageState, resetRefCounter } from "./state.js"
import { executeAction } from "./executor.js"
import type { PlanRecorder } from "../planner/plan-generator.js"
import { globals } from "../globals.js"

export interface PilotOptions {
	/** Per-step timeout in ms. */
	timeout: number
	/** Console log drain function. */
	consoleDrain: () => ConsoleEntry[]
	/** Optional plan recorder for capturing heuristic plans during discovery. */
	recorder?: PlanRecorder
	/** Wait for network requests to settle before capturing page state. */
	waitForNetworkIdle?: () => Promise<void>
}

/**
 * Run all steps of a test case sequentially.
 * Fails fast: stops on the first failed step.
 */
export async function runTestCase(
	page: Page,
	testCase: { name: string; steps: string[] },
	llm: LLMClient,
	options: PilotOptions,
): Promise<TestCaseResult> {
	const startTime = performance.now()
	const stepResults: StepResult[] = []

	// Fresh conversation history and stable ref map for each test case
	llm.resetHistory()
	resetRefCounter()

	const trace = globals.trace
	const recorder = options.recorder

	// Pre-plan all steps: the LLM interprets the full spec and returns
	// structured actions for steps it can resolve without page state.
	// Compound steps may be split into multiple atomic actions.
	trace.log("plan:start", `${String(testCase.steps.length)} steps`)
	if (globals.debug) {
		console.log(`\n      Plan input:`)
		for (const s of testCase.steps) {
			console.log(`        - ${s}`)
		}
	}
	const planStart = performance.now()
	let plan: PlannedStep[]
	try {
		plan = await llm.planSteps(testCase.steps)
	} catch (err) {
		// If planning fails, fall back to runtime resolution for all steps
		const msg = err instanceof Error ? err.message : String(err)
		trace.log("plan:error", msg)
		if (globals.debug) {
			console.log(`      Plan error: ${msg}`)
		}
		plan = testCase.steps.map((s) => ({ step: s, action: null }))
	}
	trace.log("plan:done", `${String(Math.round(performance.now() - planStart))}ms`)
	if (globals.debug) {
		console.log(`\n      Plan output (${String(plan.length)} actions):`)
		for (let i = 0; i < plan.length; i++) {
			const p = plan[i]
			const label = p.action ? JSON.stringify(p.action) : "(needs page state)"
			console.log(`        ${String(i + 1)}. ${p.step} → ${label}`)
		}
		console.log()
	}

	// Build the execution queue — EXPAND steps get expanded at runtime
	// and their sub-steps are spliced into the queue.
	const queue = [...plan]
	let queueIndex = 0
	let failed = false

	while (queueIndex < queue.length && !failed) {
		const planned = queue[queueIndex]
		queueIndex++
		const { step, action: plannedAction, needsExpansion } = planned

		// ── EXPAND: runtime step expansion (e.g. form filling) ────────
		if (needsExpansion) {
			trace.log("expand:start", step)
			if (globals.debug) {
				console.log(`\n      Expanding compound step: ${step}`)
			}

			// Capture page state for expansion
			if (options.waitForNetworkIdle) {
				await options.waitForNetworkIdle()
			}
			const state = await capturePageState(page, options.consoleDrain)

			try {
				const t0 = performance.now()
				const expandedSteps = await llm.expandStep(step, state, page)
				const expandDuration = performance.now() - t0
				trace.log("expand:done", `${String(Math.round(expandDuration))}ms → ${String(expandedSteps.length)} sub-steps`)

				if (globals.debug) {
					console.log(`\n      Expanded into ${String(expandedSteps.length)} sub-steps:`)
					for (const es of expandedSteps) {
						const label = es.action ? JSON.stringify(es.action) : "(needs page state)"
						console.log(`        - ${es.step} → ${label}`)
					}
					console.log()
				}

				// Splice expanded sub-steps into the queue at the current position
				queue.splice(queueIndex, 0, ...expandedSteps)
			} catch (err) {
				stepResults.push({
					step,
					action: null,
					status: "failed",
					duration: 0,
					error: `Failed to expand step: ${err instanceof Error ? err.message : String(err)}`,
				})
				failed = true
			}
			continue
		}

		// ── Normal step execution (same as before) ───────────────────
		trace.log("step:start", step)
		const stepStart = performance.now()
		let action: Action | null = null
		const timing: StepTiming = {
			capture: 0,
			llm: 0,
			execute: 0,
			postCapture: 0,
		}

		try {
			let a11yTree: A11yNode[] = []

			if (plannedAction) {
				// Pre-planned: skip page capture and LLM call
				action = plannedAction
				trace.log("plan:hit", JSON.stringify(action))
			} else {
				// Needs page state: wait for async requests to settle, then capture
				if (options.waitForNetworkIdle) {
					await options.waitForNetworkIdle()
				}
				trace.log("capture:start")
				let t0 = performance.now()
				const state = await capturePageState(page, options.consoleDrain)
				timing.capture = performance.now() - t0
				trace.log("capture:done", `${String(Math.round(timing.capture))}ms`)

				trace.log("llm:start")
				t0 = performance.now()
				action = await llm.resolveStep(step, state)
				timing.llm = performance.now() - t0
				trace.log(
					"llm:done",
					`${String(Math.round(timing.llm))}ms → ${JSON.stringify(action)}`,
				)

				a11yTree = state.a11yTree
			}

			if (globals.debug) {
				console.log(`      Action: ${JSON.stringify(action)}`)
			}

			// Execute the action
			trace.log("execute:start", action.action)
			let t0 = performance.now()
			const result = await executeAction(page, action, a11yTree)
			timing.execute = performance.now() - t0
			trace.log(
				"execute:done",
				`${String(Math.round(timing.execute))}ms ${result.success ? "ok" : `FAIL: ${result.error ?? ""}`}`,
			)

			if (!result.success) {
				stepResults.push({
					step,
					action,
					status: "failed",
					duration: performance.now() - stepStart,
					timing,
					error: result.error,
				})
				failed = true
				continue
			}

			// Capture post-action screenshot for reporting
			// Retry once if the page is mid-navigation
			trace.log("postCapture:start")
			t0 = performance.now()
			let postState
			try {
				postState = await capturePageState(page, options.consoleDrain, {
					screenshot: true,
				})
			} catch {
				await page.waitForLoadState("domcontentloaded")
				postState = await capturePageState(page, options.consoleDrain, {
					screenshot: true,
				})
			}
			timing.postCapture = performance.now() - t0
			trace.log(
				"postCapture:done",
				`${String(Math.round(timing.postCapture))}ms`,
			)

			// Record step for heuristic plan if recorder is active
			if (recorder && action) {
				recorder.recordStep(step, action, result, {
					url: postState.url,
					title: postState.title,
				})
			}

			stepResults.push({
				step,
				action,
				status: "passed",
				duration: performance.now() - stepStart,
				timing,
				screenshot: postState.screenshot,
			})
		} catch (err) {
			stepResults.push({
				step,
				action,
				status: "failed",
				duration: performance.now() - stepStart,
				timing,
				error: err instanceof Error ? err.message : String(err),
			})
			failed = true
		}
	}

	const allPassed = stepResults.every((s) => s.status === "passed") && !failed
	const status = allPassed ? "passed" : "failed"

	return {
		name: testCase.name,
		status,
		steps: stepResults,
		duration: performance.now() - startTime,
	}
}
