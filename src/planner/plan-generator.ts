/**
 * Plan recorder — hooks into the Pilot loop during a discovery run
 * to capture concrete actions and produce a HeuristicPlan.
 */

import type { Action, ExecutionResult } from "../reporter/types.js"
import type { HeuristicPlan, HeuristicStep } from "./plan-types.js"

/** Records concrete actions during a discovery run. */
export interface PlanRecorder {
	/** Record a successful step execution. */
	recordStep(
		step: string,
		action: Action,
		result: ExecutionResult,
		postState: { url: string; title: string },
	): void
	/** Produce the final heuristic plan from all recorded steps. */
	finalize(): HeuristicPlan
}

/**
 * Create a plan recorder for a single test case.
 * Call recordStep() after each successful step during the discovery run.
 * Call finalize() after the test passes to get the cached plan.
 */
export function createPlanRecorder(
	suiteSlug: string,
	testSlug: string,
	sourceHash: string,
	model: string,
): PlanRecorder {
	const steps: HeuristicStep[] = []

	return {
		recordStep(step, action, result, postState) {
			const hStep: HeuristicStep = {
				originalStep: step,
				action: action.action,
				postStepFingerprint: {
					url: postState.url,
					title: postState.title,
				},
			}

			// Store the resolved selector (role+name or CSS) if available
			if (result.resolvedSelector) {
				hStep.selector = { ...result.resolvedSelector }
			}

			if (action.value !== undefined) {
				hStep.value = action.value
			}

			if (action.option !== undefined) {
				hStep.option = action.option
			}

			if (action.assertion) {
				hStep.assertion = { ...action.assertion }
			}

			steps.push(hStep)
		},

		finalize() {
			return {
				suiteSlug,
				testSlug,
				sourceHash,
				model,
				generatedAt: new Date().toISOString(),
				greenlightVersion: "0.1.0",
				steps,
			}
		},
	}
}
