/**
 * The Pilot — core AI agent loop.
 * Iterates through test steps: capture state → LLM → execute → record result.
 */

import type { Page } from "playwright"
import type {
	Action,
	StepResult,
	TestCaseResult,
} from "../reporter/types.js"
import type { LLMClient } from "./llm.js"
import {
	capturePageState,
	resetRefCounter,
	formatA11yTree,
} from "./state.js"
import { executeAction } from "./executor.js"
import type { ConsoleEntry } from "../reporter/types.js"

export interface PilotOptions {
	/** Per-step timeout in ms. */
	timeout: number
	/** Console log drain function. */
	consoleDrain: () => ConsoleEntry[]
	/** Whether to print debug output. */
	debug: boolean
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

	for (const step of testCase.steps) {
		const stepStart = performance.now()
		let action: Action | null = null

		try {
			// Capture current page state
			resetRefCounter()
			const state = await capturePageState(page, options.consoleDrain)

			if (options.debug) {
				console.log(`\n      A11y tree:\n`)
				console.log(formatA11yTree(state.a11yTree))
			}

			// Ask LLM to resolve the step
			action = await llm.resolveStep(step, state)

			if (options.debug) {
				console.log(`      LLM action: ${JSON.stringify(action)}`)
			}

			// Execute the action
			const result = await executeAction(page, action, state.a11yTree)

			if (!result.success) {
				stepResults.push({
					step,
					action,
					status: "failed",
					duration: performance.now() - stepStart,
					error: result.error,
				})
				break
			}

			// Capture post-action screenshot for reporting
			const postState = await capturePageState(page, options.consoleDrain)

			stepResults.push({
				step,
				action,
				status: "passed",
				duration: performance.now() - stepStart,
				screenshot: postState.screenshot,
			})
		} catch (err) {
			stepResults.push({
				step,
				action,
				status: "failed",
				duration: performance.now() - stepStart,
				error: err instanceof Error ? err.message : String(err),
			})
			break
		}
	}

	const allPassed = stepResults.every((s) => s.status === "passed")
	// If we broke early, remaining steps weren't run — overall is failed
	const status =
		allPassed && stepResults.length === testCase.steps.length
			? "passed"
			: "failed"

	return {
		name: testCase.name,
		status,
		steps: stepResults,
		duration: performance.now() - startTime,
	}
}
