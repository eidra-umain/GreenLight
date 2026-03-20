# Internal Architecture

Deep-dive into implementation details for contributors. For user-facing docs see the README.

---

## Element References and the Accessibility Tree

GreenLight represents the page as an enriched accessibility tree with stable element references. This is the core abstraction that both the LLM and the action executor work against.

### Two-phase capture

Page state is captured in `src/pilot/state.ts` via `capturePageState()`:

**Phase 1: Parse a11y snapshot** (`src/pilot/a11y-parser.ts`)

Playwright's `page.locator("body").ariaSnapshot()` produces a raw YAML-like tree. The parser processes it line-by-line:

1. Each element gets a **structural path**: `{role}:{name}[siblingIndex]` at each tree level
2. A persistent `stableRefMap` (Map<structuralPath, ref>) assigns refs like `e1`, `e2`, `e3`
3. If the path already exists in the map, the same ref is reused — stability across captures
4. Only interactive roles get refs (button, link, textbox, checkbox, combobox, etc.)
5. Non-interactive elements get placeholders like `_role`
6. The map persists within a test case (reset between tests via `resetRefCounter()`)

**Phase 2: DOM enrichment** (`src/pilot/state.ts`)

After parsing, `enrichA11yNodes()` runs a single `page.evaluate()` to extract:

- `visibleText` — the `innerText` for buttons, headings, links
- `placeholder` — for input fields
- `value` — current input value or selected option text

Accessible names are computed with a fallback chain: `aria-label` → `aria-labelledby` → `<label>` text → `placeholder` → `alt` → `innerText` → `title`.

### Formatted output for the LLM

`formatA11yTree()` produces a human-readable representation:

```
[e1] button "Submit"
  text: "Click to submit form"
[e2] textbox "Email"
  placeholder: "Enter your email"
  value: "user@example.com"
```

### Ref resolution back to Playwright

When the LLM says "click e1", `resolveLocator()` in `src/pilot/locator.ts` converts the ref back to a Playwright locator using chained role matching, label matching, placeholder matching, or text matching — scoped by the tree hierarchy.

### Key design property

Refs are based on structural identity (role + name + sibling position), not DOM indices. The same element keeps the same ref across re-captures within a test, even as the DOM changes.

---

## URL Fingerprinting and Plan Drift

### Recording during pilot runs

After each successful step in a pilot (discovery) run, `capturePageState()` records the current URL and title. The plan generator stores this as `postStepFingerprint` on each step:

```typescript
postStepFingerprint: {
  url: postState.url,     // full page URL after step completed
  title: postState.title
}
```

### Client-side navigation timing

Client-side routers (Next.js, React Router) update the URL via `pushState` after the DOM has settled. The pilot waits for URL changes after click/navigate actions:

1. Snapshot URL before the action (`preActionUrl`)
2. After execution + `waitForLoadState("domcontentloaded")`, check if URL changed
3. If unchanged, `waitForURL()` with a 3s timeout for pushState updates
4. Invalidate the network idle cache so the next step does a full stability check

### Drift detection during cached replay

The cached runner compares post-step URLs using pathname-only comparison (ignoring query params, hashes, domain):

```typescript
function hasPathDrift(expectedUrl, actualUrl): boolean {
  return new URL(expectedUrl).pathname !== new URL(actualUrl).pathname
}
```

After navigation-triggering actions, the cached runner also uses the plan's expected URL to wait for the target page:

```typescript
if (hasPathDrift(step.postStepFingerprint.url, page.url())) {
  await page.waitForURL(`**${expectedPath}*`, { timeout: 10000 })
}
```

---

## Page Stability Between Steps

The system needs to wait for the page to be "ready" between steps. This is handled by `waitForNetworkIdle()` in `src/pilot/network.ts`.

### Architecture

```
Step N completes
    │
    ├─ [pilot only] capturePageState for plan recorder
    ├─ invalidate content cache (if click/navigate)
    │
Step N+1 starts
    │
    ├─ waitForNetworkIdle()
    │   ├─ Fast path: no pending requests + content matches last snapshot → return immediately
    │   ├─ Phase 1 (network): wait for zero in-flight requests (100ms grace, 1s cap)
    │   └─ Phase 2 (DOM): wait for textContent to stabilize (300ms grace, 1.5s cap)
    │
    ├─ [pilot] capturePageState → LLM → execute
    └─ [cached] executeHeuristicStep
```

### Fast path

Tracks `lastContent` (body textContent from the previous idle check). If no requests are pending and content matches, returns immediately — zero overhead. This handles the common case of consecutive steps on a stable page.

### Phase 1: Network idle

Tracks in-flight requests via Playwright's `request`/`requestfinished`/`requestfailed` events. Waits for the pending set to be empty for 100ms (grace period for chained requests). Capped at 1s — anything still in-flight after that is likely a slow prefetch or background request.

**Background request filtering** — these are excluded from the pending set entirely:
- `prefetch` and `ping` resource types
- Analytics: googletagmanager.com, googlesyndication.com, google-analytics.com, cookiebot.com
- Media streaming (HLS manifests, video chunks)

### Phase 2: DOM content stability

Polls `body.textContent()` every 100ms. Waits for 300ms of no change. Capped at 1.5s — if content is still changing after that, it's live content (animations, streaming) that shouldn't block step execution.

Uses `textContent` (not `innerText`) because some frameworks render content that CSS hides from `innerText` during transitions.

### Content cache invalidation

After click/navigate actions, `lastContent` is cleared so the fast path can't short-circuit on stale content. This is critical for client-side navigation where the old page's content is still in the DOM when the fast path runs.

### Pilot vs cached runner differences

**Pilot:**
- Pre-step: `waitForNetworkIdle` → `capturePageState` → LLM → execute
- Post-step: `waitForLoadState("domcontentloaded")` + URL wait for navigation + invalidate cache
- No redundant `waitForNetworkIdle` after execution — the next step's pre-step idle handles it

**Cached runner:**
- Pre-step: `waitForNetworkIdle` only
- Post-step: URL wait using plan's expected fingerprint + invalidate cache
- No post-step `waitForNetworkIdle` — eliminated as redundant with the next step's pre-step idle

### Performance measurement

The `--perf` flag shows per-step timing breakdown:

```
✓ click "Submit" (850ms) [net:310 dom:420 exec:120ms]
```

- `net` — Phase 1 duration (network idle wait)
- `dom` — Phase 2 duration (content stability wait)
- `exec` — action execution time
- `capture` / `llm` / `post` / `settle` — pilot-only phases

Zero-value phases are omitted.

---

## Map Testing

### Detection and attachment

When the planner encounters map-related steps, it inserts a `MAP_DETECT` step. The detection in `src/map/index.ts` polls for up to 10s, trying registered adapters in order.

### MapLibre adapter

The adapter in `src/map/adapters/maplibre.ts` finds the map instance through multiple strategies:

1. Explicit: `window.__greenlight_map`
2. Constructor hook: `window.__greenlight_map_instances`
3. Global variables: `window.map`, `window.mapInstance`, etc.
4. DOM property scan on `.maplibregl-map` containers
5. React fiber tree walking (covers react-map-gl)
6. Vue internals (Vue 2 and 3)

Once found, the instance is stored as `window.__greenlight_map_instance`.

**Important constraint:** No `addInitScript` for map library hooking. Injecting scripts that define properties on `window` breaks the library's environment detection, Web Worker setup, and WebGL tile rendering. All discovery happens at runtime via DOM/framework inspection.

### Map state capture

`captureMapState()` calls `waitForIdle()` (waits for `map.once("idle")` with 10s timeout), then `getState()` which reads center, zoom, bearing, pitch, bounds, and layer list from the map instance.

### Map assertions

Map assertions in `src/pilot/assertions.ts` support:

- **Feature search**: `queryRenderedFeatures()` queries all visible vector tile features, matching by name property
- **Zoom checks**: numeric comparison against `map.getZoom()`
- **Layer checks**: presence check against `map.getStyle().layers`

Both pilot and cached runner capture map state before assertion steps when a map adapter is active.
