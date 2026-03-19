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
 * Trace logger — logs timestamped browser and pilot events for performance analysis.
 * Enabled with --trace. Attaches to Playwright page events and provides
 * a log() function for manual instrumentation.
 */

import type { Page } from "playwright"

export interface TraceLogger {
	log(event: string, detail?: string): void
	attachToPage(page: Page): void
	detachFromPage(page: Page): void
}

const GREY = "\x1b[90m"
const RESET = "\x1b[0m"

/**
 * Create a trace logger. If enabled is false, returns a no-op logger.
 */
export function createTraceLogger(enabled: boolean): TraceLogger {
	if (!enabled) {
		return {
			log() {
				// no-op
			},
			attachToPage() {
				// no-op
			},
			detachFromPage() {
				// no-op
			},
		}
	}

	const startTime = performance.now()

	function ts(): string {
		return String(Math.round(performance.now() - startTime)).padStart(7, " ")
	}

	function log(event: string, detail?: string): void {
		const d = detail ? ` ${detail}` : ""
		console.log(`${GREY}[${ts()}ms] ${event}${d}${RESET}`)
	}

	/** URL patterns for media/third-party resources to exclude from trace. */
	const NOISE_PATTERNS = [
		/\.pmtiles/,
		/\.pbf$/,
		/\.png$/,
		/\.jpg$/,
		/\.jpeg$/,
		/\.gif$/,
		/\.svg$/,
		/\.webp$/,
		/\.woff2?$/,
		/\.ttf$/,
		/\.mp4$/,
		/\.webm$/,
		/googlesyndication\.com/,
		/googletagmanager\.com/,
		/google-analytics\.com/,
		/cookiebot\.com/,
		/protomaps\.github\.io/,
	]

	function isNoise(url: string): boolean {
		return NOISE_PATTERNS.some((p) => p.test(url))
	}

	// Store bound handlers so we can remove them
	const handlers = new WeakMap<
		Page,
		Record<string, (...args: unknown[]) => void>
	>()

	function attachToPage(page: Page): void {
		const h = {
			framenavigated: (frame: unknown) => {
				const f = frame as { url: () => string; parentFrame: () => unknown }
				if (!f.parentFrame()) {
					log("navigation", f.url())
				}
			},
			load: () => {
				log("page:load")
			},
			domcontentloaded: () => {
				log("page:domcontentloaded")
			},
			request: (req: unknown) => {
				const r = req as { url: () => string; resourceType: () => string }
				const type = r.resourceType()
				if (
					(type === "document" || type === "xhr" || type === "fetch") &&
					!isNoise(r.url())
				) {
					log(`request:${type}`, r.url())
				}
			},
			response: (res: unknown) => {
				const r = res as {
					url: () => string
					status: () => number
					request: () => { resourceType: () => string }
				}
				const type = r.request().resourceType()
				if (
					(type === "document" || type === "xhr" || type === "fetch") &&
					!isNoise(r.url())
				) {
					log(`response:${type}`, `${String(r.status())} ${r.url()}`)
				}
			},
			console: (msg: unknown) => {
				const m = msg as { type: () => string; text: () => string }
				if (m.type() === "error") {
					log("console:error", m.text())
				}
			},
		}

		handlers.set(page, h)

		page.on("framenavigated", h.framenavigated)
		page.on("load", h.load)
		page.on("domcontentloaded", h.domcontentloaded)
		page.on("request", h.request)
		page.on("response", h.response)
		page.on("console", h.console)
	}

	function detachFromPage(page: Page): void {
		const h = handlers.get(page)
		if (!h) return
		page.off("framenavigated", h.framenavigated)
		page.off("load", h.load)
		page.off("domcontentloaded", h.domcontentloaded)
		page.off("request", h.request)
		page.off("response", h.response)
		page.off("console", h.console)
		handlers.delete(page)
	}

	return { log, attachToPage, detachFromPage }
}
