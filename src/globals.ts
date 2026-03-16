/**
 * Global runtime state — set once at CLI startup, read anywhere.
 * Eliminates the need to thread debug/trace through every function signature.
 */

import type { TraceLogger } from "./pilot/trace.js"

export const globals = {
	/** Verbose debug output (--debug). */
	debug: false,
	/** Trace logger instance (--trace). Always present; no-op when tracing is disabled. */
	trace: {
		log() {},
		attachToPage() {},
		detachFromPage() {},
	} as TraceLogger,
}

/**
 * Initialize globals from CLI options. Call once at startup.
 */
export function initGlobals(opts: {
	debug: boolean
	trace: TraceLogger
}): void {
	globals.debug = opts.debug
	globals.trace = opts.trace
}
