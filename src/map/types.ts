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
 * Pluggable map adapter interface.
 *
 * Each adapter knows how to detect a specific map library on the page,
 * extract its state, wait for it to be ready, and query rendered features.
 * Implementations live in ./adapters/.
 *
 * All map interaction MUST go through this interface — never access
 * window.__greenlight_map_instance or library-specific APIs directly
 * from outside the adapter. This ensures new map libraries (Leaflet,
 * Mapbox GL, etc.) can be added without changing consuming code.
 */

import type { Page } from "playwright"

/** Geographic coordinate (longitude, latitude). */
export interface LngLat {
	lng: number
	lat: number
}

/** Geographic bounding box. */
export interface LngLatBounds {
	sw: LngLat
	ne: LngLat
}

/** A feature returned by the map's spatial query API. */
export interface MapFeature {
	/** Layer ID the feature belongs to. */
	layer: string
	/** Feature properties (key-value pairs from the source data). */
	properties: Record<string, unknown>
	/** Geometry type (Point, LineString, Polygon, etc.). */
	geometryType?: string
}

/** Snapshot of the map's current viewport and layer state. */
export interface MapState {
	/** Which adapter produced this state (e.g. "maplibre", "leaflet", "mapbox"). */
	adapter: string
	/** Map center coordinate. */
	center: LngLat
	/** Current zoom level. */
	zoom: number
	/** Camera bearing in degrees (0 = north). */
	bearing: number
	/** Camera pitch in degrees (0 = straight down). */
	pitch: number
	/** Visible bounds of the viewport. */
	bounds: LngLatBounds
	/** IDs of all layers in the current style. */
	layers: string[]
	/** Whether the map style is fully loaded. */
	styleLoaded: boolean
}

/**
 * A map adapter encapsulates all browser-side interaction with a specific
 * map library. All methods receive a Playwright Page and execute logic
 * inside the browser via page.evaluate().
 */
export interface MapAdapter {
	/** Short identifier (e.g. "maplibre", "leaflet", "mapbox"). */
	readonly name: string

	/**
	 * Detect whether this map library is present and has an active instance.
	 * Returns true if the map is found on the page.
	 */
	detect(page: Page): Promise<boolean>

	/**
	 * Attach to the map instance on the page.
	 * After this call, the adapter can extract state and interact with the map.
	 * Throws if no map instance is found.
	 */
	attach(page: Page): Promise<void>

	/**
	 * Wait for the map to finish loading tiles and rendering.
	 * Resolves when the map is idle and safe to query/screenshot.
	 */
	waitForIdle(page: Page): Promise<void>

	/**
	 * Extract the current map viewport state.
	 */
	getState(page: Page): Promise<MapState>

	/**
	 * Query features rendered at a specific pixel coordinate on the canvas.
	 * If layers is provided, restrict the query to those layer IDs.
	 */
	queryFeatures(
		page: Page,
		point: { x: number; y: number },
		layers?: string[],
	): Promise<MapFeature[]>

	/**
	 * Query ALL features currently rendered in the viewport.
	 * Returns features across all layers (or filtered by layer IDs).
	 * Used for assertions like "map shows Örebro" — searches feature
	 * properties (e.g. name) across everything visible on the canvas.
	 */
	queryRenderedFeatures(
		page: Page,
		layers?: string[],
	): Promise<MapFeature[]>
}
