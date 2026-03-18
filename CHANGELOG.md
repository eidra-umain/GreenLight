# Changelog

All notable changes to this project will be documented in this file.

## [0.4.0] - 2026-03-18

Unified page state, conditional steps, CLI and architecture improvements

**Architecture**: Unified page state representation

- Enriched a11y tree nodes with visible text, placeholder, and value from the DOM
- LLM can now match fuzzy descriptions to elements (e.g. "password field" matches
  textbox with placeholder "Enter visitor password")

**Feature**: Conditional if/then/else steps

- New IF_VISIBLE/IF_CONTAINS/IF_URL planner tokens for inline conditionals
- Condition evaluation uses the pilot LLM via the same conversation flow as
  resolveStep (shared history, compact diffs, JSON action response format)
- Both branches cacheable in heuristic plans; drift detected on branch switch
- CLI shows [then]/[else]/[skipped] tags on conditional step output
- New conditions.ts module for code-based evaluation (used in cached plan replay)

**Browser lifecycle fix**

- Fixed Chromium crash dialog on macOS by SIGKILL via CDP SystemInfo.getProcessInfo
  instead of Playwright's close() which triggers a SIGSEGV in Chrome 145 shutdown code

**Documentation**

- Added comprehensive "Writing test steps" section to README covering all action
  types, enriched tree format, conditionals, form filling, assertions, map testing
- Consolidated old "Test syntax" section into a quick-reference table

## [0.3.0] - 2026-03-18

### Added

- **Numeric comparison assertions** — steps like `check that the count of produkter shown is greater than 0` now work. Supports `greater than`, `less than`, `at least`, `at most`, `equals`, and `not equal` with literal numbers. Works via `assert numeric` in the planner and `COMPARE_VALUE` in the parser.
- **`element_disabled` / `element_enabled` assertion types** — verify button state with steps like `verify that the "Submit" button is disabled`. Searches multiple interactive roles (button, link, radio, checkbox, tab, menuitem), with polling for `element_enabled` to handle async state changes.
- **Custom radio card support** — Chakra UI radio cards and similar custom components (rendered as `text` nodes inside `radiogroup` in the a11y tree) now get element refs and can be targeted by click actions.
- **Live step progress output** — step results are now printed as they complete during both discovery and cached runs, instead of all at once after the test finishes.

### Changed

- **Prompt architecture overhaul** — all three LLM prompts (planner, runtime, expander) restructured with consistent section headers, clear decision trees, and inline extension guide. The planner prompt uses classification-first routing for assertions.
- **Page stabilization after every action** — clicks, types, selects, and other mutating actions now wait for `domcontentloaded` + network idle before proceeding to the next step. Applies to both discovery and cached runs. Eliminates race conditions where pre-resolved assertions ran before the page settled.
- **Real keypresses for all text input** — `type` and `autocomplete` actions now use `page.keyboard.type()` instead of Playwright's `fill()`. This fires real keydown/keypress/input events per character, required for frameworks with per-character rendering (e.g. formatted inputs, live validation). Input clearing uses Cmd/Ctrl+A + Backspace instead of `fill("")`.
- **Force-click on inputs** — the initial focus click for type actions uses `force: true` to bypass actionability checks, handling inputs with decorative icon overlays (search icons, location pins).
- **`pickVisible` checks visibility for single matches** — locator resolution now verifies even single-match locators are visible before returning, allowing fallback to alternative locator strategies.
- **Locator text fallback uses step hint** — when resolving `text` role nodes (e.g. radio cards), the locator extracts the quoted text from the step instruction for matching, instead of using the full concatenated a11y node name which often mismatches the DOM.
- **Shared quote handling** — `extractQuotedText()` and `stripQuotes()` utilities handle straight and curly quotes consistently across locator resolution, keyword search, and map assertions.
- **Compare assertion resilience** — falls back to keyword search when the LLM targets the wrong element (e.g. a heading instead of the count), when the element ref is stale, or when the variable name is `"_"` (literal comparison).

### Fixed

- **Disabled button click fails fast** — clicking a disabled element now throws immediately with a clear error message instead of timing out for 30 seconds.
- **Cached plan preserves `literal` field** — `COMPARE_VALUE` assertions with literal numbers now work correctly in cached runs.
- **Cached plan handles `text` role nodes** — `buildLocator` in the cached runner resolves `text` role elements via `getByText` instead of the invalid `getByRole('text', ...)`.
- **Keyword search proximity matching** — when a number and its label keyword are in separate DOM elements (adjacent lines), the search now finds numbers within 80 characters of a keyword match.
- **Keyword search strips quotes** — quoted content words in step descriptions (e.g. `'produkter'`) no longer fail keyword matching.

### Documentation

- **Language convention** — test steps referencing page content must use the same language as the application under test. Added to specifications with good/bad examples.
- **Prompt extension guide** — file-level comments in `prompts.ts` explain how the three prompts relate and provide checklists for adding new actions or assertion types.

## [0.2.0] - 2026-03-17

### Added

- **Map testing support** — pluggable adapter architecture for testing pages with interactive WebGL maps. Write steps like `check that the map shows "Stockholm"` and GreenLight queries the map's actual rendered features (place names, road labels, etc.) from vector tile data.
- **MapLibre GL JS adapter** — automatic map instance detection via React fiber tree walking, Vue internals, global variable scanning, and explicit `window.__greenlight_map` exposure.
- **`MAP_DETECT` planner step** — automatically inserted before map-related steps. Fails the test early if no supported map is found.
- **`map_state` assertion type** — evaluates conditions against the map's rendered features (name search), viewport state (zoom level checks), and layer visibility. Works in both discovery and cached plan runs.
- **`queryRenderedFeatures` adapter method** — queries all features visible in the map viewport, used by map assertions to verify map content without coordinates.
- **75% browser zoom in headed mode** via the `playwright-zoom` extension for a better visual overview during test development.
- **Multi-provider LLM support** — native integrations for OpenRouter, OpenAI, Google Gemini, and Anthropic Claude. Configure via `provider` in `greenlight.yaml` or `--provider` CLI flag. Separate planner/pilot model selection for balancing quality and cost.
- **LLM API error abort** — 4xx and 5xx responses from any LLM provider now abort the entire test run immediately instead of failing individual steps.

### Changed

- **`X-E2E-Test` header is now same-origin only** — previously added to all requests via `extraHTTPHeaders`, which triggered CORS preflight failures on cross-origin tile servers and CDNs. Now injected per-request via route interception, only on same-origin navigation, fetch, and XHR requests.
- **Headed mode uses persistent browser context** — required for the zoom extension, with pages closed between tests instead of full context teardown.
- **Remember action fallback** — when the LLM targets an element for a `remember` action but the variable name implies a number and the captured text has none, the executor falls back to keyword search in the accessibility tree.

### Fixed

- Cross-origin map tile requests (e.g. PMTiles on DigitalOcean Spaces) no longer fail due to CORS preflight triggered by the `X-E2E-Test` header.

## [0.1.0] - 2026-03-17

Initial NPM release.
