/**
 * The Pilot — core AI agent loop.
 * Iterates through test steps: capture state → LLM → execute → record result.
 */

import type { Page } from "playwright"
import type {
	A11yNode,
	Action,
	ConsoleEntry,
	MapState,
	StepResult,
	StepTiming,
	TestCaseResult,
} from "../reporter/types.js"
import type { LLMClient } from "./llm.js"
import type { PlannedStep } from "./response-parser.js"
import { validatePlanReferences } from "./response-parser.js"
import { capturePageState } from "./state.js"
import { resetRefCounter } from "./a11y-parser.js"
import { executeAction } from "./executor.js"
import type { PlanRecorder } from "../planner/plan-generator.js"
import type { MapAdapter } from "../map/types.js"
import { detectMap } from "../map/index.js"
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
	/** Called after each step completes, for live progress output. */
	onStepComplete?: (result: StepResult) => void
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
	const recordStep = (result: StepResult) => {
		stepResults.push(result)
		options.onStepComplete?.(result)
	}

	// Fresh conversation history, stable ref map, and value store for each test case
	llm.resetHistory()
	resetRefCounter()
	globals.valueStore.clear()

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
		// LLM API errors (4xx/5xx) must abort the entire run
		const { LLMApiError } = await import("./providers/index.js")
		if (err instanceof LLMApiError) throw err

		// Other planning failures — fall back to runtime resolution
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

	// Validate that every COMPARE has a matching REMEMBER before it
	const planErrors = validatePlanReferences(plan)
	if (planErrors.length > 0) {
		if (globals.debug) {
			for (const err of planErrors) console.log(`      Plan error: ${err}`)
		}
		// Log the errors but don't fail — the LLM may have made a mistake
		// that the runtime can still handle
	}

	// Build the execution queue — EXPAND steps get expanded at runtime
	// and their sub-steps are spliced into the queue.
	const queue = [...plan]
	let queueIndex = 0
	let failed = false

	// Map adapter — set by MAP_DETECT, then passed to all subsequent state captures
	let mapAdapter: MapAdapter | null = null
	// Latest captured map state — passed to assertions
	let latestMapState: MapState | undefined

	while (queueIndex < queue.length && !failed) {
		const planned = queue[queueIndex]
		queueIndex++
		const { step, action: plannedAction, needsExpansion, needsMapDetect, rememberAs, compare: plannedCompare } = planned

		// ── MAP_DETECT: find and attach to a map instance ─────────────
		if (needsMapDetect) {
			trace.log("map:detect", step)
			const stepStart = performance.now()
			try {
				if (options.waitForNetworkIdle) {
					await options.waitForNetworkIdle()
				}
				mapAdapter = await detectMap(page)
				if (!mapAdapter) {
					recordStep({
						step,
						action: null,
						status: "failed",
						duration: performance.now() - stepStart,
						error: "No supported map library detected on the page. Ensure the page contains a MapLibre GL, Mapbox GL, or Leaflet map.",
					})
					failed = true
				} else {
					trace.log("map:detected", mapAdapter.name)
					// Record in heuristic plan so cached runs also detect the map
					if (recorder) {
						recorder.recordStep(
							step,
							{ action: "map_detect" },
							{ success: true, duration: performance.now() - stepStart },
							{ url: page.url(), title: await page.title() },
						)
					}
					recordStep({
						step,
						action: null,
						status: "passed",
						duration: performance.now() - stepStart,
					})
				}
			} catch (err) {
				recordStep({
					step,
					action: null,
					status: "failed",
					duration: performance.now() - stepStart,
					error: `Map detection failed: ${err instanceof Error ? err.message : String(err)}`,
				})
				failed = true
			}
			continue
		}

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
			const state = await capturePageState(page, options.consoleDrain, {
				mapAdapter: mapAdapter ?? undefined,
			})

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
				recordStep({
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

		// ── CONDITIONAL: evaluate condition and splice chosen branch ──
		if (planned.condition) {
			trace.log("condition:eval", `${planned.condition.type} "${planned.condition.target}"`)
			const stepStart = performance.now()

			if (options.waitForNetworkIdle) {
				await options.waitForNetworkIdle()
			}

			// Capture page state and let the LLM evaluate the condition
			const state = await capturePageState(page, options.consoleDrain, {
				mapAdapter: mapAdapter ?? undefined,
			})
			const conditionMet = await llm.evaluateCondition(
				planned.condition.target,
				planned.condition.type,
				state,
			)
			trace.log("condition:result", String(conditionMet))

			if (globals.debug) {
				console.log(`      Condition ${planned.condition.type} "${planned.condition.target}": ${String(conditionMet)}`)
			}

			const branch = conditionMet ? planned.thenBranch : planned.elseBranch
			const branchLabel = conditionMet ? "then" : (planned.elseBranch ? "else" : "skipped")

			if (branch && branch.length > 0) {
				// Splice the chosen branch into the queue at the current position
				queue.splice(queueIndex, 0, ...branch)
			}

			// Record the conditional evaluation step
			if (recorder) {
				recorder.recordConditionalStep(step, planned.condition, conditionMet, branch)
			}

			recordStep({
				step,
				action: null,
				status: "passed",
				duration: performance.now() - stepStart,
				conditionResult: { met: conditionMet, branch: branchLabel },
			})
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
				const state = await capturePageState(page, options.consoleDrain, {
					mapAdapter: mapAdapter ?? undefined,
				})
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
				if (state.mapState) latestMapState = state.mapState
			}

			// For map_state assertions on pre-planned actions (no state capture
			// above), fetch fresh map state so the assertion has data to check.
			if (action.assertion?.type === "map_state" && !latestMapState && mapAdapter) {
				const { captureMapState: getMapState } = await import("../map/index.js")
				latestMapState = await getMapState(page, mapAdapter)
			}

			// Propagate rememberAs from planned step to action
			if (rememberAs) {
				action.rememberAs = rememberAs
				// If the LLM didn't return a "remember" action for a REMEMBER step,
				// wrap it as one so the executor captures the value
				if (action.action !== "remember") {
					action = { action: "remember", ref: action.ref, text: action.text, rememberAs }
				}
			}

			// Propagate compare metadata from planned step to action.
			// The plan is authoritative for comparison logic — always override
			// whatever the runtime LLM may have generated (it doesn't know
			// about literal values or the correct variable name).
			if (plannedCompare) {
				action.compare = {
					variable: plannedCompare.variable,
					operator: plannedCompare.operator as Action["compare"] extends { operator: infer O } ? O : never,
					...(plannedCompare.literal !== undefined ? { literal: plannedCompare.literal } : {}),
				}
				action.assertion = { type: "compare", expected: step }
				action.action = "assert"
			}

			if (globals.debug) {
				console.log(`      Action: ${JSON.stringify(action)}`)
			}

			// Execute the action
			trace.log("execute:start", action.action)
			let t0 = performance.now()
			const result = await executeAction(page, action, a11yTree, undefined, {
				state: latestMapState,
				adapter: mapAdapter ?? undefined,
			}, step)
			timing.execute = performance.now() - t0
			trace.log(
				"execute:done",
				`${String(Math.round(timing.execute))}ms ${result.success ? "ok" : `FAIL: ${result.error ?? ""}`}`,
			)

			if (!result.success) {
				recordStep({
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

			// Store remembered value if this was a remember action
			if (result.rememberedValue !== undefined && action.rememberAs) {
				globals.valueStore.set(action.rememberAs, result.rememberedValue)
			}

			// Wait for the page to stabilize after mutating actions
			// (click, type, select, etc.) so the next step sees a settled page.
			// Assertions don't mutate the page, so skip for those.
			if (action.action !== "assert") {
				await page.waitForLoadState("domcontentloaded")
				if (options.waitForNetworkIdle) {
					await options.waitForNetworkIdle()
				}
			}

			// Capture post-action screenshot for reporting
			trace.log("postCapture:start")
			t0 = performance.now()
			let postState
			try {
				postState = await capturePageState(page, options.consoleDrain, {
					screenshot: true,
					mapAdapter: mapAdapter ?? undefined,
				})
			} catch {
				await page.waitForLoadState("domcontentloaded")
				postState = await capturePageState(page, options.consoleDrain, {
					screenshot: true,
					mapAdapter: mapAdapter ?? undefined,
				})
			}
			timing.postCapture = performance.now() - t0
			trace.log(
				"postCapture:done",
				`${String(Math.round(timing.postCapture))}ms`,
			)
			if (postState.mapState) latestMapState = postState.mapState

			// Record step for heuristic plan if recorder is active
			if (recorder) {
				recorder.recordStep(step, action, result, {
					url: postState.url,
					title: postState.title,
				})
			}

			recordStep({
				step,
				action,
				status: "passed",
				duration: performance.now() - stepStart,
				timing,
				screenshot: postState.screenshot,
			})
		} catch (err) {
			// LLM API errors (4xx/5xx) must abort the entire run — re-throw
			// so the CLI loop can catch and stop.
			const { LLMApiError } = await import("./providers/index.js")
			if (err instanceof LLMApiError) throw err

			recordStep({
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
