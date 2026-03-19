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

/**
 * Attach a network request tracker to a page.
 * Call once after page creation. The returned `waitForNetworkIdle` function
 * waits until all in-flight requests have completed (with a grace period
 * to allow follow-up requests to start).
 */
export function attachNetworkTracker(page: Page): {
	waitForNetworkIdle: (timeoutMs?: number) => Promise<void>
} {
	const pending = new Set<Request>()

	page.on("request", (req) => pending.add(req))
	page.on("requestfinished", (req) => pending.delete(req))
	page.on("requestfailed", (req) => pending.delete(req))

	return {
		/**
		 * Wait until the page has settled: network requests done AND
		 * rendered content stable. Two phases:
		 * 1. Wait for zero in-flight requests (with grace period for chained requests)
		 * 2. Wait for innerText to stop changing (catches CSS transitions/animations)
		 */
		async waitForNetworkIdle(timeoutMs = 5000): Promise<void> {
			const deadline = performance.now() + timeoutMs

			// Phase 1: wait for network requests to complete
			const networkGrace = 200
			let quietSince = pending.size === 0 ? performance.now() : 0
			while (performance.now() < deadline) {
				if (pending.size === 0) {
					if (!quietSince) quietSince = performance.now()
					if (performance.now() - quietSince >= networkGrace) break
				} else {
					quietSince = 0
				}
				await new Promise((r) => setTimeout(r, 50))
			}

			// Phase 2: wait for DOM content to stabilize.
			// Use textContent (not innerText) because some frameworks
			// render content that CSS hides from innerText during animations.
			// textContent sees all DOM text regardless of CSS.
			const contentGrace = 300
			let previous: string
			try {
				previous =
					(await page.locator("body").textContent()) ?? ""
			} catch {
				return
			}
			let stableSince = performance.now()
			while (performance.now() < deadline) {
				await new Promise((r) => setTimeout(r, 100))
				let current: string
				try {
					current =
						(await page.locator("body").textContent()) ?? ""
				} catch {
					return
				}
				if (current !== previous) {
					previous = current
					stableSince = performance.now()
				} else if (performance.now() - stableSince >= contentGrace) {
					return
				}
			}
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
