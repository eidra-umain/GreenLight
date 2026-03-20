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
 * Network idle tracking and console log collection for Playwright pages.
 */

import type { Page, Request } from "playwright"
import type { ConsoleEntry } from "../reporter/types.js"
import { globals } from "../globals.js"

/**
 * Attach a network request tracker to a page.
 * Call once after page creation. The returned `waitForNetworkIdle` function
 * waits until all in-flight requests have completed (with a grace period
 * to allow follow-up requests to start).
 */
/** Timing breakdown from the last waitForNetworkIdle call. */
export interface IdleTiming {
	/** Time spent waiting for network requests to complete (ms). */
	network: number
	/** Time spent waiting for DOM content to stabilize (ms). */
	content: number
}

export function attachNetworkTracker(page: Page): {
	waitForNetworkIdle: (timeoutMs?: number) => Promise<void>
	/** Invalidate the content cache so the next idle wait does a full check. */
	invalidate: () => void
	/** Timing from the last waitForNetworkIdle call. */
	lastIdleTiming: () => IdleTiming
} {
	const pending = new Set<Request>()

	/** Requests that don't affect page readiness. */
	function isBackgroundRequest(req: Request): boolean {
		const url = req.url()
		const type = req.resourceType()

		// Prefetch/preload/prerender link requests
		if (type === "prefetch" || type === "ping") return true

		// Analytics and tracking
		if (url.includes("googletagmanager.com")) return true
		if (url.includes("googlesyndication.com")) return true
		if (url.includes("google-analytics.com")) return true
		if (url.includes("cookiebot.com")) return true

		// Media streaming (video chunks, HLS manifests)
		if (type === "media") return true

		return false
	}

	page.on("request", (req) => {
		if (!isBackgroundRequest(req)) {
			pending.add(req)
		}
	})
	page.on("requestfinished", (req) => pending.delete(req))
	page.on("requestfailed", (req) => pending.delete(req))

	// Track last known content across calls for fast-path detection
	let lastContent = ""
	let _lastTiming: IdleTiming = { network: 0, content: 0 }

	return {
		/**
		 * Wait until the page has settled: network requests done AND
		 * rendered content stable. Two phases:
		 * 1. Wait for zero in-flight requests (with grace period for chained requests)
		 * 2. Wait for innerText to stop changing (catches CSS transitions/animations)
		 *
		 * Fast path: if network is already quiet and content matches the
		 * last known snapshot, return immediately — no grace periods needed.
		 */
		async waitForNetworkIdle(timeoutMs = 5000): Promise<void> {
			// Fast path: nothing in-flight and content unchanged since last call
			if (pending.size === 0 && lastContent) {
				try {
					const current = (await page.locator("body").textContent()) ?? ""
					if (current === lastContent) {
						_lastTiming = { network: 0, content: 0 }
						return
					}
				} catch {
					_lastTiming = { network: 0, content: 0 }
					return
				}
			}

			// Phase 1: wait for network requests to complete.
			// Capped at 1s — if requests are still in-flight after that,
			// they're likely prefetches or slow background requests.
			const phase1Start = performance.now()
			const networkDeadline = performance.now() + Math.min(timeoutMs, 1000)
			const networkGrace = 100
			let quietSince = pending.size === 0 ? performance.now() : 0
			while (performance.now() < networkDeadline) {
				if (pending.size === 0) {
					if (!quietSince) quietSince = performance.now()
					if (performance.now() - quietSince >= networkGrace) break
				} else {
					quietSince = 0
				}
				await new Promise((r) => setTimeout(r, 50))
			}
			const phase1Duration = performance.now() - phase1Start

			if (globals.debug && pending.size > 0) {
				console.log(`      [net] Phase 1 timed out with ${String(pending.size)} pending:`)
				for (const req of pending) {
					console.log(`        ${req.resourceType()} ${req.url().slice(0, 120)}`)
				}
			}

			// Phase 2: wait for DOM content to stabilize.
			// Use textContent (not innerText) because some frameworks
			// render content that CSS hides from innerText during animations.
			// textContent sees all DOM text regardless of CSS.
			// Own timeout (1.5s) — animations/transitions should be done by then.
			// If content is still changing, it's live content and we shouldn't block.
			const phase2Start = performance.now()
			const contentDeadline = performance.now() + 1500
			const contentGrace = 300
			let previous: string
			try {
				previous =
					(await page.locator("body").textContent()) ?? ""
			} catch {
				_lastTiming = { network: phase1Duration, content: performance.now() - phase2Start }
				return
			}
			let stableSince = performance.now()
			while (performance.now() < contentDeadline) {
				await new Promise((r) => setTimeout(r, 100))
				let current: string
				try {
					current =
						(await page.locator("body").textContent()) ?? ""
				} catch {
					_lastTiming = { network: phase1Duration, content: performance.now() - phase2Start }
					return
				}
				if (current !== previous) {
					previous = current
					stableSince = performance.now()
				} else if (performance.now() - stableSince >= contentGrace) {
					lastContent = current
					_lastTiming = { network: phase1Duration, content: performance.now() - phase2Start }
					return
				}
			}
			// Timed out — save whatever we have
			lastContent = previous
			_lastTiming = { network: phase1Duration, content: performance.now() - phase2Start }
		},

		invalidate() {
			lastContent = ""
		},

		lastIdleTiming() {
			return _lastTiming
		},
	}
}

/**
 * Collect console messages from a page.
 * Call attachConsoleCollector(page) once after page creation,
 * then drainConsoleLogs() to retrieve and clear collected entries.
 */
export function attachConsoleCollector(page: Page): {
	drain: () => ConsoleEntry[]
} {
	const logs: ConsoleEntry[] = []

	page.on("console", (msg) => {
		logs.push({ type: msg.type(), text: msg.text() })
	})

	return {
		drain() {
			const snapshot = [...logs]
			logs.length = 0
			return snapshot
		},
	}
}
