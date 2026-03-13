/**
 * Shared result and state types used across the Pilot, Runner, and Reporters.
 */

/** An annotated node from the accessibility tree with a stable element ref. */
export interface A11yNode {
	ref: string
	role: string
	name: string
	level?: number
	url?: string
	children?: A11yNode[]
	raw: string
}

/** Complete page state captured at a point in time. */
export interface PageState {
	/** Accessibility tree snapshot with element refs assigned. */
	a11yTree: A11yNode[]
	/** Raw aria snapshot text from Playwright. */
	a11yRaw: string
	/** Base64-encoded PNG screenshot of the viewport. */
	screenshot: string
	/** Current page URL. */
	url: string
	/** Current page title. */
	title: string
	/** Console messages since last capture. */
	consoleLogs: ConsoleEntry[]
}

/** A single browser console message. */
export interface ConsoleEntry {
	type: string
	text: string
}

/** Result of executing a single action in the browser. */
export interface ExecutionResult {
	/** Whether the action completed successfully. */
	success: boolean
	/** Duration in milliseconds. */
	duration: number
	/** Error message if the action failed. */
	error?: string
}

/** Result of a single step within a test case. */
export interface StepResult {
	/** The plain-English step text. */
	step: string
	/** The action the LLM chose. */
	action: Action | null
	/** Pass or fail. */
	status: "passed" | "failed"
	/** Total duration for this step (LLM + execution) in ms. */
	duration: number
	/** Post-action screenshot (base64 PNG). */
	screenshot?: string
	/** Error message if the step failed. */
	error?: string
}

/** Result of running a full test case (all steps). */
export interface TestCaseResult {
	/** Test case name. */
	name: string
	/** Overall status — failed if any step failed. */
	status: "passed" | "failed"
	/** Per-step results. */
	steps: StepResult[]
	/** Total duration in ms. */
	duration: number
}

/** A structured action returned by the LLM for a single step. */
export interface Action {
	/** The action type (click, type, select, scroll, navigate, wait, assert). */
	action: string
	/** Element ref from the a11y tree (e.g. "e5"). */
	ref?: string
	/** Value to type, URL to navigate to, option to select, etc. */
	value?: string
	/** Assertion details for assert actions. */
	assertion?: {
		type: string
		expected: string
	}
}
