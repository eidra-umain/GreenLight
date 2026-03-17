/**
 * MapLibre GL JS adapter.
 *
 * The main challenge is finding the Map instance. In framework apps (React,
 * Vue, etc.) the instance is typically held in a closure or component state
 * — not on the DOM or window. We use multiple runtime strategies:
 *
 * 1. Explicit exposure: window.__greenlight_map
 * 2. Common global variable names
 * 3. Container DOM property scan
 * 4. React fiber tree walking (covers react-map-gl)
 * 5. Vue internals (Vue 2 and 3)
 *
 * IMPORTANT: No init scripts (addInitScript) must be used to hook into map
 * library constructors. Injecting scripts that define properties on window
 * (e.g. window.maplibregl via Object.defineProperty) breaks the library's
 * environment detection, Web Worker setup, and WebGL tile rendering — tiles
 * fail to load even though DOM markers still work. All instance discovery
 * must happen at runtime via DOM/framework inspection.
 */

import type { Page } from "playwright"
import type { MapAdapter, MapState, MapFeature } from "../types.js"

export const maplibreAdapter: MapAdapter = {
	name: "maplibre",

	async detect(page: Page): Promise<boolean> {
		return page.evaluate(() => {
			// Explicit exposure
			if ((window as any).__greenlight_map) return true

			// Instances captured by the constructor hook
			const instances = (window as any).__greenlight_map_instances
			if (instances && instances.length > 0) return true

			// Check for maplibregl global
			if ((window as any).maplibregl) return true

			// Check for maplibre container class on any element
			return document.querySelector(".maplibregl-map") !== null
		})
	},

	async attach(page: Page): Promise<void> {
		const result = await page.evaluate(() => {
			// Already attached?
			if ((window as any).__greenlight_map_instance) return { ok: true }

			function isMapInstance(obj: any): boolean {
				return (
					obj != null &&
					typeof obj === "object" &&
					typeof obj.getCenter === "function" &&
					typeof obj.getZoom === "function" &&
					typeof obj.getBearing === "function" &&
					typeof obj.getStyle === "function"
				)
			}

			function claim(inst: any): { ok: true } {
				;(window as any).__greenlight_map_instance = inst
				return { ok: true }
			}

			// Strategy 1: explicit exposure
			const explicit = (window as any).__greenlight_map
			if (isMapInstance(explicit)) return claim(explicit)

			// Strategy 2: instances captured by the constructor hook
			const instances = (window as any).__greenlight_map_instances ?? []
			for (const inst of instances) {
				if (isMapInstance(inst)) return claim(inst)
			}

			// Strategy 3: scan common global variable names
			for (const key of ["map", "mapInstance", "mapRef", "glMap", "maplibreMap"]) {
				try {
					const candidate = (window as any)[key]
					if (isMapInstance(candidate)) return claim(candidate)
				} catch { /* skip */ }
			}

			// Strategy 4: walk own properties on .maplibregl-map containers
			const containers = document.querySelectorAll(".maplibregl-map")
			for (const container of containers) {
				for (const key of Object.keys(container)) {
					try {
						const val = (container as any)[key]
						if (isMapInstance(val)) return claim(val)
					} catch { /* skip */ }
				}
			}

			// Strategy 5: React internals — walk the fiber tree from the
			// maplibre container upward, checking refs and hook state for
			// the map instance. Covers react-map-gl and similar wrappers.
			for (const container of containers) {
				const fiberKey = Object.keys(container).find(
					(k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"),
				)
				if (!fiberKey) continue

				let fiber = (container as any)[fiberKey]
				const visited = new Set()
				while (fiber && !visited.has(fiber)) {
					visited.add(fiber)

					// Check ref (react-map-gl MapRef has getMap())
					try {
						const ref = typeof fiber.ref === "function" ? null : fiber.ref
						if (ref?.current) {
							if (isMapInstance(ref.current)) return claim(ref.current)
							if (typeof ref.current.getMap === "function") {
								const m = ref.current.getMap()
								if (isMapInstance(m)) return claim(m)
							}
						}
					} catch { /* skip */ }

					// Check stateNode
					try {
						if (isMapInstance(fiber.stateNode)) return claim(fiber.stateNode)
						if (fiber.stateNode && typeof fiber.stateNode.getMap === "function") {
							const m = fiber.stateNode.getMap()
							if (isMapInstance(m)) return claim(m)
						}
					} catch { /* skip */ }

					// Walk React hooks linked list (memoizedState chain)
					try {
						let hook = fiber.memoizedState
						const hookVisited = new Set()
						while (hook && !hookVisited.has(hook)) {
							hookVisited.add(hook)
							// Hook value can be in .memoizedState (useState/useRef)
							// or in .queue.lastRenderedState
							for (const val of [hook.memoizedState, hook.queue?.lastRenderedState]) {
								if (isMapInstance(val)) return claim(val)
								// useRef stores { current: ... }
								if (val?.current && isMapInstance(val.current)) return claim(val.current)
								if (val?.current?.getMap) {
									try {
										const m = val.current.getMap()
										if (isMapInstance(m)) return claim(m)
									} catch { /* skip */ }
								}
							}
							hook = hook.next
						}
					} catch { /* skip */ }

					// Check memoizedProps
					try {
						const props = fiber.memoizedProps
						if (props) {
							for (const key of Object.keys(props)) {
								const val = props[key]
								if (isMapInstance(val)) return claim(val)
								if (val?.current && isMapInstance(val.current)) return claim(val.current)
							}
						}
					} catch { /* skip */ }

					fiber = fiber.return
				}
			}

			// Strategy 6: Vue internals — check __vue_app__ and __vue__
			for (const container of containers) {
				try {
					const vue3 = (container as any).__vue_app__
						?? (container as any).parentElement?.__vue_app__
					if (vue3) {
						// Walk component tree — Vue 3 stores state in setup results
						const walk = (node: any, depth: number): any => {
							if (!node || depth > 10) return null
							const proxy = node.proxy
							if (proxy) {
								for (const key of Object.keys(proxy)) {
									try {
										if (isMapInstance(proxy[key])) return proxy[key]
										if (proxy[key]?.current && isMapInstance(proxy[key].current))
											return proxy[key].current
									} catch { /* skip */ }
								}
							}
							// Check subTree component children
							const sub = node.subTree
							if (sub?.children) {
								for (const child of (Array.isArray(sub.children) ? sub.children : [])) {
									const found = walk(child?.component, depth + 1)
									if (found) return found
								}
							}
							const comp = sub?.component
							if (comp) {
								const found = walk(comp, depth + 1)
								if (found) return found
							}
							return null
						}
						const rootComp = vue3._instance ?? vue3._container?.__vue_app__?._instance
						const found = walk(rootComp, 0)
						if (found) return claim(found)
					}
				} catch { /* skip */ }

				try {
					// Vue 2
					const vue2 = (container as any).__vue__
						?? (container as any).parentElement?.__vue__
					if (vue2) {
						// Check $data and $refs
						for (const key of [...Object.keys(vue2.$data ?? {}), ...Object.keys(vue2.$refs ?? {})]) {
							try {
								const val = (vue2.$data ?? {})[key] ?? (vue2.$refs ?? {})[key]
								if (isMapInstance(val)) return claim(val)
							} catch { /* skip */ }
						}
					}
				} catch { /* skip */ }
			}

			// Collect diagnostic info for the error message
			const diag: string[] = []
			diag.push(`containers: ${String(containers.length)}`)
			diag.push(`hook instances: ${String(instances.length)}`)
			diag.push(`maplibregl global: ${String(!!(window as any).maplibregl)}`)
			if (containers.length > 0) {
				const c = containers[0]
				const ownKeys = Object.keys(c).filter((k) => !k.startsWith("__react"))
				diag.push(`container own keys: [${ownKeys.slice(0, 10).join(", ")}]`)
				const reactKey = Object.keys(c).find((k) => k.startsWith("__reactFiber$"))
				diag.push(`react fiber: ${String(!!reactKey)}`)
				const vueKey = !!(c as any).__vue__ || !!(c as any).__vue_app__
				diag.push(`vue: ${String(vueKey)}`)
			}

			return { ok: false as const, diag: diag.join("; ") }
		})

		if (!result.ok) {
			throw new Error(
				"MapLibre map instance not found. " +
				"Add `window.__greenlight_map = map` in your app for reliable detection. " +
				`[${(result as any).diag ?? "no diagnostics"}]`,
			)
		}
	},

	async waitForIdle(page: Page): Promise<void> {
		await page.evaluate(() => {
			const map = (window as any).__greenlight_map_instance
			if (!map) return

			return new Promise<void>((resolve) => {
				// Already idle?
				if (
					typeof map.isStyleLoaded === "function" &&
					map.isStyleLoaded() &&
					typeof map.areTilesLoaded === "function" &&
					map.areTilesLoaded()
				) {
					resolve()
					return
				}

				// Wait for the idle event (fires when all rendering is done)
				const timeout = setTimeout(() => resolve(), 10000)
				map.once("idle", () => {
					clearTimeout(timeout)
					resolve()
				})
			})
		})
	},

	async getState(page: Page): Promise<MapState> {
		return page.evaluate(() => {
			const map = (window as any).__greenlight_map_instance
			if (!map) {
				throw new Error("MapLibre map instance not attached")
			}

			const center = map.getCenter()
			const bounds = map.getBounds()
			const style = map.getStyle()
			const layers = (style?.layers ?? []).map(
				(l: any) => l.id as string,
			)

			return {
				adapter: "maplibre",
				center: { lng: center.lng, lat: center.lat },
				zoom: map.getZoom(),
				bearing: map.getBearing(),
				pitch: map.getPitch(),
				bounds: {
					sw: {
						lng: bounds.getSouthWest().lng,
						lat: bounds.getSouthWest().lat,
					},
					ne: {
						lng: bounds.getNorthEast().lng,
						lat: bounds.getNorthEast().lat,
					},
				},
				layers,
				styleLoaded:
					typeof map.isStyleLoaded === "function"
						? map.isStyleLoaded()
						: true,
			}
		})
	},

	async queryFeatures(
		page: Page,
		point: { x: number; y: number },
		layers?: string[],
	): Promise<MapFeature[]> {
		return page.evaluate(
			({ point, layers }) => {
				const map = (window as any).__greenlight_map_instance
				if (!map) {
					throw new Error("MapLibre map instance not attached")
				}

				const options: any = {}
				if (layers && layers.length > 0) {
					options.layers = layers
				}

				const features = map.queryRenderedFeatures(
					[point.x, point.y],
					options,
				)

				return (features ?? []).slice(0, 50).map((f: any) => ({
					layer: f.layer?.id ?? "unknown",
					properties: f.properties ?? {},
					geometryType: f.geometry?.type,
				}))
			},
			{ point, layers },
		)
	},

	async queryRenderedFeatures(
		page: Page,
		layers?: string[],
	): Promise<MapFeature[]> {
		return page.evaluate(
			(layers) => {
				const map = (window as any).__greenlight_map_instance
				if (!map) {
					throw new Error("MapLibre map instance not attached")
				}

				const options: any = {}
				if (layers && layers.length > 0) {
					options.layers = layers
				}

				// No point/bbox argument = query entire viewport
				const features = map.queryRenderedFeatures(options)

				// Limit serialized output — only include features that have
				// meaningful string properties (names, labels, etc.)
				const results: any[] = []
				for (const f of features) {
					const props: Record<string, unknown> = {}
					let hasStringProp = false
					for (const [k, v] of Object.entries(f.properties ?? {})) {
						if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
							props[k] = v
							if (typeof v === "string" && v.length > 0) hasStringProp = true
						}
					}
					if (hasStringProp) {
						results.push({
							layer: f.layer?.id ?? "unknown",
							properties: props,
							geometryType: f.geometry?.type,
						})
					}
					if (results.length >= 500) break
				}
				return results
			},
			layers ?? null,
		)
	},
}
