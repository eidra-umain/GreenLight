/**
 * Shared types used across all GreenLight modules.
 */

/** Viewport dimensions for the browser. */
export interface Viewport {
	width: number
	height: number
}

/** Supported LLM provider identifiers. */
export type Provider = "openrouter" | "openai" | "gemini" | "claude"

/** Per-role model configuration (planner vs pilot can use different models). */
export interface ModelConfig {
	planner: string
	pilot: string
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
	/** LLM model identifier or per-role config. */
	model: string | ModelConfig
	/** LLM provider to use. */
	provider: Provider
	/** Base URL for the LLM API (optional override). */
	llmBaseUrl?: string
	/** Force a full pilot (LLM) run, ignoring cached plans. */
	pilot: boolean
	/** Behavior on plan drift: "fail" (default) or "rerun" with LLM. */
	onDrift: "fail" | "rerun"
}

/** Resolve a model string or ModelConfig into a full ModelConfig. */
export function resolveModelConfig(model: string | ModelConfig): ModelConfig {
	if (typeof model === "string") {
		return { planner: model, pilot: model }
	}
	return model
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
	| "provider"
	| "pilot"
	| "onDrift"
> = {
	reporter: "cli",
	headed: false,
	parallel: 1,
	timeout: 30_000,
	viewport: { width: 1280, height: 720 },
	model: "anthropic/claude-sonnet-4",
	provider: "openrouter",
	pilot: false,
	onDrift: "fail",
}
