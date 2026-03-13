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
