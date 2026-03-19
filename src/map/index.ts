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
 * Map detection and lifecycle management.
 *
 * Provides a registry of map adapters and a function to detect which
 * (if any) map library is active on the current page.
 *
 * To add a new map library: implement MapAdapter in ./adapters/ and
 * register it here via registerMapAdapter(). All map interaction from
 * the pilot, executor, and assertions goes through the adapter interface.
 */

import type { Page } from "playwright"
import type { MapAdapter, MapState } from "./types.js"
import { maplibreAdapter } from "./adapters/maplibre.js"
import { globals } from "../globals.js"

export type { MapAdapter, MapState, MapFeature, LngLat, LngLatBounds } from "./types.js"


// ── Adapter registry ─────────────────────────────────────────────────

/** All registered adapters, tried in order during detection. */
const adapters: MapAdapter[] = [maplibreAdapter]

/**
 * Register an additional map adapter.
 * Adapters are tried in registration order during detection.
 */
export function registerMapAdapter(adapter: MapAdapter): void {
	adapters.push(adapter)
}

// ── Detection & attachment ───────────────────────────────────────────

/**
 * Detect which map library is present on the page, attach to it,
 * and return the adapter. Returns null if no supported map is found.
 *
 * Maps often initialize asynchronously (loading styles, creating the
 * canvas, etc.), so we retry detection with a short poll interval
 * for up to `timeoutMs` before giving up.
 *
 * This is the entry point called by the pilot when it encounters a
 * MAP_DETECT step.
 */
export async function detectMap(
	page: Page,
	timeoutMs = 10000,
): Promise<MapAdapter | null> {
	const pollInterval = 500
	const deadline = Date.now() + timeoutMs

	if (globals.debug) {
		console.log(`      [map] Waiting up to ${String(timeoutMs)}ms for a map to appear...`)
	}

	while (Date.now() < deadline) {
		for (const adapter of adapters) {
			try {
				const found = await adapter.detect(page)
				if (found) {
					if (globals.debug) {
						console.log(`      [map] Detected ${adapter.name} map`)
					}
					await adapter.attach(page)
					if (globals.debug) {
						console.log(`      [map] Attached to ${adapter.name} instance`)
					}
					// Wait for the map to be fully loaded before returning
					await adapter.waitForIdle(page)
					if (globals.debug) {
						console.log(`      [map] Map is idle and ready`)
					}
					return adapter
				}
			} catch (err) {
				if (globals.debug) {
					const msg = err instanceof Error ? err.message : String(err)
					console.log(`      [map] ${adapter.name} detection/attach error: ${msg}`)
				}
				// Attach failed — map detected but not ready yet, keep retrying
			}
		}

		// Wait before next attempt
		await page.waitForTimeout(pollInterval)
	}

	return null
}

/**
 * Wait for the map to be idle, then capture its state.
 * Call this during page state capture when a map adapter is active.
 */
export async function captureMapState(
	page: Page,
	adapter: MapAdapter,
): Promise<MapState> {
	await adapter.waitForIdle(page)
	return adapter.getState(page)
}
