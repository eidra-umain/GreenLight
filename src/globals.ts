// GreenLight E2E Testing
// Copyright (c) 2026 Umain AB Sweden
//
// This program is free software: you can redistribute it and/or
// modify it under the terms of the GNU General Public License as
// published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

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
		log() { /* noop */ },
		attachToPage() { /* noop */ },
		detachFromPage() { /* noop */ },
	} as TraceLogger,
	/** Value store for remember/compare across steps within a test case. */
	valueStore: new Map<string, string>(),
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
