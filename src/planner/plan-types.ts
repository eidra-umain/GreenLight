/**
 * Types for cached heuristic test plans.
 * A heuristic plan is a concrete, element-bound action sequence
 * derived from a successful discovery run, replayable without LLM calls.
 */

/** How to locate an element during cached plan replay. */
export interface HeuristicSelector {
	/** ARIA role from the a11y tree (for ref-based resolution). */
	role?: string
	/** Accessible name from the a11y tree. */
	name?: string
	/** CSS DOM selector extracted from the element (for text-based fallback resolution). */
	css?: string
	/** Zero-based index when multiple elements match the same role+name. */
	nth?: number
}

/** A single concrete step in a heuristic plan. */
export interface HeuristicStep {
	/** The original natural-language step text. */
	originalStep: string
	/** The action type (click, type, select, scroll, navigate, press, wait, assert). */
	action: string
	/** Element selector — undefined for actions without a target (navigate, press, assert, etc.). */
	selector?: HeuristicSelector
	/** Value: text to type, URL to navigate, key to press, scroll direction, etc. */
	value?: string
	/** For autocomplete actions: the specific suggestion to select. */
	option?: string
	/** Assertion details for assert actions. */
	assertion?: { type: string; expected: string }
	/** Page state after the step executed, for drift detection. */
	postStepFingerprint: {
		url: string
		title: string
	}
}

/** A complete cached plan for one test case. */
export interface HeuristicPlan {
	/** Slugified suite name (used as directory). */
	suiteSlug: string
	/** Slugified test case name (used as filename). */
	testSlug: string
	/** SHA-256 hash of the test case's effective definition (resolved steps). */
	sourceHash: string
	/** LLM model used during the discovery run. */
	model: string
	/** ISO 8601 timestamp of plan generation. */
	generatedAt: string
	/** GreenLight version that generated the plan. */
	greenlightVersion: string
	/** The concrete steps to replay. */
	steps: HeuristicStep[]
}
