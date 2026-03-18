/**
 * Plan recorder — hooks into the Pilot loop during a discovery run
 * to capture concrete actions and produce a HeuristicPlan.
 */

import type { Action, ExecutionResult } from "../reporter/types.js"
import type { HeuristicPlan, HeuristicStep } from "./plan-types.js"
import type { Condition } from "../pilot/conditions.js"
import type { PlannedStep } from "../pilot/response-parser.js"

/** Records concrete actions during a discovery run. */
export interface PlanRecorder {
	/** Record a successful step execution. */
	recordStep(
		step: string,
		action: Action,
		result: ExecutionResult,
		postState: { url: string; title: string },
	): void
	/** Record a conditional step evaluation. */
	recordConditionalStep(
		step: string,
		condition: Condition,
		conditionMet: boolean,
		branch: PlannedStep[] | undefined,
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

			if (action.rememberAs !== undefined) {
				hStep.rememberAs = action.rememberAs
			}

			if (action.compare) {
				hStep.compare = { ...action.compare }
			}

			if (action.assertion) {
				hStep.assertion = { ...action.assertion }
			}

			steps.push(hStep)
		},

		recordConditionalStep(step, condition, conditionMet, _branch) {
			const branchLabel = conditionMet ? "then" : (_branch ? "else" : "skipped")
			const hStep: HeuristicStep = {
				originalStep: step,
				action: "conditional",
				condition: { type: condition.type, target: condition.target },
				discoveryBranch: branchLabel as "then" | "else" | "skipped",
				postStepFingerprint: { url: "", title: "" },
			}
			// Note: the branch sub-steps will be recorded individually as they
			// execute — they are spliced into the queue and go through recordStep().
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
