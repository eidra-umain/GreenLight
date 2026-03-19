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
	PageState,
	StepResult,
	StepTiming,
	TestCaseResult,
} from "../reporter/types.js"
import type { LLMClient } from "./llm.js"
import type { PlannedStep } from "./response-parser.js"
import { fixPlanOrdering, validatePlanReferences } from "./response-parser.js"
import { resolveDatePick } from "./datepick.js"
import { stepNeedsRandom, injectRandomValues, replaceWithPlaceholders, type RandomValues } from "./random.js"
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
	/** Capture post-step screenshots (default: false). */
	screenshots?: boolean
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
	/** Index of the queue entry currently being executed (set in the loop). */
	let currentQueuePlanned: PlannedStep | null = null
	const recordStep = (result: StepResult) => {
		stepResults.push(result)
		if (result.status === "passed" && currentQueuePlanned?.inputStepIndex != null) {
			lastCompletedInputStep = Math.max(lastCompletedInputStep, currentQueuePlanned.inputStepIndex)
		}
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

	// Fix ordering: REMEMBER+COMPARE back-to-back for same variable → swap
	fixPlanOrdering(plan)

	// Validate that every COMPARE has a matching REMEMBER before it
	const planErrors = validatePlanReferences(plan)
	if (planErrors.length > 0) {
		if (globals.debug) {
			for (const err of planErrors) console.log(`      Plan error: ${err}`)
		}
		// Log the errors but don't fail — the LLM may have made a mistake
		// that the runtime can still handle
	}

	if (globals.debug) {
		console.log(`\n      Input step mapping:`)
		for (const p of plan) {
			console.log(`        [${String(p.inputStepIndex ?? "?")}] ${p.step}`)
		}
	}

	// Build the execution queue — EXPAND steps get expanded at runtime
	// and their sub-steps are spliced into the queue.
	const queue = [...plan]
	let queueIndex = 0
	let failed = false
	let lastCompletedInputStep = -1

	// Track whether we're inside a DATEPICK expansion — sub-steps should
	// not be individually recorded in the heuristic plan (the whole datepick
	// will be re-expanded with fresh timestamps on cached replay).
	let insideDatePick = false
	let datepickSubStepsRemaining = 0

	// Map adapter — set by MAP_DETECT, then passed to all subsequent state captures
	let mapAdapter: MapAdapter | null = null
	// Latest captured map state — passed to assertions
	let latestMapState: MapState | undefined

	while (queueIndex < queue.length && !failed) {
		const planned = queue[queueIndex]
		queueIndex++
		currentQueuePlanned = planned
		const { step, action: plannedAction, needsExpansion, needsDatePick, needsMapDetect, needsCount, rememberAs, compare: plannedCompare } = planned

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

		// ── DATEPICK: resolve date/time picker with chrono-node ──────
		if (needsDatePick) {
			trace.log("datepick:start", step)
			if (globals.debug) {
				console.log(`\n      Resolving date picker step: ${step}`)
			}

			if (options.waitForNetworkIdle) {
				await options.waitForNetworkIdle()
			}
			const state = await capturePageState(page, options.consoleDrain, {
				mapAdapter: mapAdapter ?? undefined,
			})

			// Ask the LLM which picker group to target (it can see the a11y tree).
			// The step text is e.g. "set the end time to..." and the tree has groups
			// like "Start date and time", "End date and time".
			let groupHint: string | undefined
			try {
				const groupStep = `Which date/time picker group on this page should be used for: "${step}"? Respond with ONLY the group name, nothing else.`
				const groupAction = await llm.resolveStep(groupStep, state)
				// The LLM returns a text action — extract the group name from the value or text
				groupHint = groupAction.value ?? groupAction.text
				if (globals.debug) {
					console.log(`      [datepick] LLM group hint: "${groupHint ?? "none"}"`)
				}
			} catch {
				// LLM couldn't help — fall through to fuzzy matching
			}

			try {
				const t0 = performance.now()
				const expandedSteps = resolveDatePick(step, state.a11yTree, groupHint)
				const duration = performance.now() - t0
				trace.log("datepick:done", `${String(Math.round(duration))}ms → ${String(expandedSteps.length)} sub-steps`)

				if (globals.debug) {
					console.log(`      Date picker resolved into ${String(expandedSteps.length)} sub-steps:`)
					for (const es of expandedSteps) {
						console.log(`        - ${JSON.stringify(es.action)}`)
					}
					console.log()
				}

				// Record a single datepick marker in the heuristic plan.
				// Sub-steps will NOT be individually recorded — the datepick
				// will be re-resolved with fresh timestamps on cached replay.
				if (recorder) {
					recorder.recordStep(
						step,
						{ action: "datepick", value: step, option: groupHint },
						{ success: true, duration },
						{ url: page.url(), title: await page.title() },
					)
				}

				// Track how many sub-steps to skip recording for
				insideDatePick = true
				datepickSubStepsRemaining = expandedSteps.length
				queue.splice(queueIndex, 0, ...expandedSteps)
			} catch (err) {
				recordStep({
					step,
					action: null,
					status: "failed",
					duration: 0,
					error: `Failed to resolve date picker: ${err instanceof Error ? err.message : String(err)}`,
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

		// ── COUNT: count elements on the live page ──────────────────
		if (needsCount) {
			trace.log("count:start", step)
			const stepStart2 = performance.now()

			if (options.waitForNetworkIdle) {
				await options.waitForNetworkIdle()
			}
			const state = await capturePageState(page, options.consoleDrain, {
				mapAdapter: mapAdapter ?? undefined,
			})

			try {
				// Ask the LLM to identify the common denominator text for the elements to count
				const countAction = await llm.resolveStep(
					`Count the number of elements matching: "${step}". Return a count action with the common text or role description that matches all target elements.`,
					state,
				)

				// Ensure it's treated as a count action
				if (countAction.action !== "count") {
					countAction.action = "count"
				}
				if (!countAction.text && !countAction.ref) {
					// Use the step description as fallback
					countAction.text = step
				}
				countAction.rememberAs = rememberAs

				if (globals.debug) {
					console.log(`      [count] LLM resolved: text="${countAction.text ?? ""}" ref="${countAction.ref ?? ""}"`)
				}

				const result = await executeAction(page, countAction, state.a11yTree)

				if (!result.success) {
					recordStep({
						step,
						action: countAction,
						status: "failed",
						duration: performance.now() - stepStart2,
						error: result.error,
					})
					failed = true
					continue
				}

				// Store the count in valueStore
				if (result.rememberedValue !== undefined && rememberAs) {
					globals.valueStore.set(rememberAs, result.rememberedValue)
				}

				// Record in heuristic plan
				if (recorder) {
					recorder.recordStep(
						step,
						{ ...countAction, value: countAction.text },
						result,
						{ url: page.url(), title: await page.title() },
					)
				}

				recordStep({
					step,
					action: countAction,
					status: "passed",
					duration: performance.now() - stepStart2,
				})
			} catch (err) {
				const { LLMApiError } = await import("./providers/index.js")
				if (err instanceof LLMApiError) throw err

				recordStep({
					step,
					action: null,
					status: "failed",
					duration: performance.now() - stepStart2,
					error: `Count failed: ${err instanceof Error ? err.message : String(err)}`,
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

		// Inject random values into steps that mention "random"
		let randomValues: RandomValues | null = null
		let resolveStep = step
		if (!plannedAction && stepNeedsRandom(step)) {
			const injected = injectRandomValues(step)
			resolveStep = injected.step
			randomValues = injected.values
			if (globals.debug) {
				console.log(`      [random] Injected: number="${randomValues.number}", string="${randomValues.string}"`)
				console.log(`      [random] Step prompt: ${resolveStep}`)
			}
		}

		try {
			let a11yTree: A11yNode[] = []
			let lastPageState: PageState | undefined

			if (plannedAction) {
				// Pre-planned: skip LLM call but capture page state if
				// the action uses a ref (needed for locator resolution).
				action = plannedAction
				trace.log("plan:hit", JSON.stringify(action))
				if (action.ref) {
					if (options.waitForNetworkIdle) {
						await options.waitForNetworkIdle()
					}
					const t0 = performance.now()
					const state = await capturePageState(page, options.consoleDrain, {
						mapAdapter: mapAdapter ?? undefined,
					})
					timing.capture = performance.now() - t0
					a11yTree = state.a11yTree
					lastPageState = state
					if (state.mapState) latestMapState = state.mapState
				}
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
				action = await llm.resolveStep(resolveStep, state)
				timing.llm = performance.now() - t0
				trace.log(
					"llm:done",
					`${String(Math.round(timing.llm))}ms → ${JSON.stringify(action)}`,
				)

				a11yTree = state.a11yTree
				lastPageState = state
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
				// Escalate to planner model for a second opinion before giving up
				if (lastPageState) {
					try {
						const plannerAction = await llm.resolveStepWithPlanner(resolveStep, lastPageState)
						if (plannerAction) {
							if (globals.debug) {
								console.log(`      [escalate] Pilot failed, retrying with planner model`)
								console.log(`      [escalate] Action: ${JSON.stringify(plannerAction)}`)
							}

							// Propagate plan metadata to the escalated action
							if (rememberAs) {
								plannerAction.rememberAs = rememberAs
								if (plannerAction.action !== "remember") {
									plannerAction.action = "remember"
								}
							}
							if (plannedCompare) {
								plannerAction.compare = {
									variable: plannedCompare.variable,
									operator: plannedCompare.operator as Action["compare"] extends { operator: infer O } ? O : never,
									...(plannedCompare.literal !== undefined ? { literal: plannedCompare.literal } : {}),
								}
								plannerAction.assertion = { type: "compare", expected: step }
								plannerAction.action = "assert"
							}

							const retryResult = await executeAction(page, plannerAction, a11yTree, undefined, {
								state: latestMapState,
								adapter: mapAdapter ?? undefined,
							}, step)

							if (retryResult.success) {
								if (globals.debug) {
									console.log(`      [escalate] Planner model succeeded`)
								}
								action = plannerAction

								// Store remembered value
								if (retryResult.rememberedValue !== undefined && plannerAction.rememberAs) {
									globals.valueStore.set(plannerAction.rememberAs, retryResult.rememberedValue)
								}

								// Wait for page to stabilize
								if (plannerAction.action !== "assert") {
									await page.waitForLoadState("domcontentloaded")
									if (options.waitForNetworkIdle) {
										await options.waitForNetworkIdle()
									}
								}

								// Record in heuristic plan
								if (recorder && !insideDatePick) {
									const recordAction = randomValues && plannerAction.value
										? { ...plannerAction, value: replaceWithPlaceholders(plannerAction.value, randomValues) }
										: plannerAction
									recorder.recordStep(step, recordAction, retryResult, {
										url: page.url(),
										title: await page.title(),
									})
								}

								// Record success and continue to next step
								recordStep({
									step,
									action: plannerAction,
									status: "passed",
									duration: performance.now() - stepStart,
									timing,
								})
								continue
							}
						}
					} catch (escalateErr) {
						if (globals.debug) {
							console.log(`      [escalate] Planner model also failed: ${escalateErr instanceof Error ? escalateErr.message : String(escalateErr)}`)
						}
					}
				}

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
					screenshot: options.screenshots ?? false,
					mapAdapter: mapAdapter ?? undefined,
				})
			} catch {
				await page.waitForLoadState("domcontentloaded")
				postState = await capturePageState(page, options.consoleDrain, {
					screenshot: options.screenshots ?? false,
					mapAdapter: mapAdapter ?? undefined,
				})
			}
			timing.postCapture = performance.now() - t0
			trace.log(
				"postCapture:done",
				`${String(Math.round(timing.postCapture))}ms`,
			)
			if (postState.mapState) latestMapState = postState.mapState

			// Record step for heuristic plan if recorder is active.
			// Skip for datepick sub-steps — the datepick marker was already
			// recorded and will be re-expanded with fresh timestamps on replay.
			if (recorder && !insideDatePick) {
				// Replace random values with placeholders so cached runs
				// generate fresh random values on replay.
				const recordAction = randomValues && action.value
					? { ...action, value: replaceWithPlaceholders(action.value, randomValues) }
					: action
				recorder.recordStep(step, recordAction, result, {
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

			// Track datepick sub-step completion
			if (insideDatePick) {
				datepickSubStepsRemaining--
				if (datepickSubStepsRemaining <= 0) {
					insideDatePick = false
				}
			}
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
		completedInputSteps: lastCompletedInputStep + 1,
	}
}
