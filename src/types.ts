/**
 * Shared types used across all GreenLight modules.
 */

/** Viewport dimensions for the browser. */
export interface Viewport {
	width: number
	height: number
}

/** Runtime configuration resolved from CLI args + suite config. */
export interface RunConfig {
	/** Path(s) to suite YAML files. */
	suiteFiles: string[]
	/** Filter: only run test cases matching this name. */
	testFilter?: string
	/** Override the suite's base_url. */
	baseUrl?: string
	/** Output format. */
	reporter: "cli" | "json" | "html"
	/** Path to write report file (stdout if omitted). */
	outputPath?: string
	/** Run browser in headed (visible) mode. */
	headed: boolean
	/** Number of test cases to run in parallel. */
	parallel: number
	/** Per-step timeout in milliseconds. */
	timeout: number
	/** Browser viewport dimensions. */
	viewport: Viewport
	/** LLM model identifier (e.g. "anthropic/claude-sonnet-4"). */
	model: string
	/** Base URL for the OpenAI-compatible LLM API. */
	llmBaseUrl: string
}

/** Default configuration values. */
export const DEFAULTS: Pick<
	RunConfig,
	| "reporter"
	| "headed"
	| "parallel"
	| "timeout"
	| "viewport"
	| "model"
	| "llmBaseUrl"
> = {
	reporter: "cli",
	headed: false,
	parallel: 1,
	timeout: 30_000,
	viewport: { width: 1280, height: 720 },
	model: "anthropic/claude-sonnet-4",
	llmBaseUrl: "https://openrouter.ai/api/v1",
}
