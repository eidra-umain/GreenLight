# Changelog

All notable changes to this project will be documented in this file.

## [0.8.1] - 2026-04-18

Improved LLM response parsing reliability.

### Fixed

- **Response parser** -- base plan responses now filter to only numbered `#N` lines, stripping LLM fluff text that could cause incorrect step parsing. Expanded plan responses are parsed separately using a dedicated path.

## [0.8.0] - 2026-04-15

Claude Code as LLM provider.

### Added

- **Claude Code provider** -- use the Claude Code CLI as a local LLM provider with `provider: claude-code`. No API key needed, runs as a subprocess.

### Fixed

- **Response parser** -- improved raw response parsing to handle LLM output that includes extra text around the JSON action.

## [0.7.7] - 2026-03-23

Documentation updates.

### Changed

- **Contributing section:** Added contributor guidelines to README, welcoming PRs and explaining the project's alpha status at Umain AB.

## [0.7.6] - 2026-03-22

Page error detection for navigation failures.

### Added

- **Page error logging:** HTTP 4xx/5xx responses on navigation are now detected and reported as step failures, in both pilot and cached runs. Previously, navigating to a broken page would silently continue until a later step failed with a confusing error.

## [0.7.5] - 2026-03-20

Faster network idle detection.

### Changed

- **Tighter network idle timeouts:** Phase 1 (network) cap reduced from 2s to 1s and grace period from 200ms to 100ms, reducing idle overhead on pages with slow background requests.

## [0.7.4] - 2026-03-20

Performance and reliability improvements for cached plan runs.

### Added

- **`--perf` flag:** Per-step performance breakdown showing network wait (`net`), DOM stabilization (`dom`), capture, LLM, and execution times. Works in both pilot and cached runs.

### Changed

- **Faster cached runs:** Smarter network idle detection skips unnecessary wait times. Background requests (analytics, media streaming) no longer block step execution. Typical cached step overhead reduced from ~600ms to near-zero when the page is already stable.

### Fixed

- **Cached `clear` action on input fields:** Clearing text inputs in cached runs now correctly targets the input element instead of its label.
- **False drift on client-side navigation:** The pilot now waits for URL updates from client-side routers (Next.js, React Router) before recording the URL fingerprint, preventing false "plan drift" errors on cached replay.
- **Cached steps running before page loads:** After navigation-triggering clicks, the cached runner now waits for the target page to load before running the next step.

## [0.7.0] - 2026-03-19

### Added

- **Clear action:** New `clear` action intelligently clears fields, filters, and selections. For text inputs: select-all + delete. For filter chips, dropdowns, and tag inputs: automatically finds and clicks the nearest clear/remove/reset button (searches within the element and siblings, matching labels in multiple languages including Swedish). Test writers just say "clear the search field" or "clear the Elektriker filter".
- **Planner model escalation:** When the pilot LLM fails to resolve a step, the system automatically retries with the more capable planner model before giving up. One-shot call with fresh page state, no conversation history. Only triggers when planner and pilot use different models.
- **Context length recovery:** When the LLM returns a context-length-exceeded error, the pilot automatically clears conversation history and retries with a fresh context instead of aborting the entire test run.
- **Large page handling:** Pages with many repeated elements (e.g. 42 installer cards) get a compressed accessibility tree. The first 3 items in a repeated group are shown in full; the rest are summarized as one-liners with just the heading/name. Conversation history is also pruned automatically when approaching the token budget.

## [0.6.0] - 2026-03-19

### Added

- **Scroll to top/bottom/element:** The `scroll` action now supports `"top"` and `"bottom"` to jump to the start or end of the page, and element targeting via `ref` or `text` to scroll a specific element into view. The planner resolves `scroll to top/bottom` statically and routes `scroll to <element>` through the pilot for live page resolution.
- **Viewport assertions:** New `element_in_viewport` / `element_not_in_viewport` assertion types check whether an element is within the visible browser viewport at the current scroll position. Uses `getBoundingClientRect()` intersection with the window dimensions. Useful after scroll actions to verify an element was scrolled into (or out of) view.

## [0.5.0] - 2026-03-19

### Added

- **Count + compare assertions:** Steps like `check that the number of product cards equals "product count"` are now automatically split into a `COUNT` + `COMPARE` by the planner. The count result is stored as a variable and compared against the remembered value, no page-text search needed.
- **Compare supports stored variables as current value:** When the assertion's expected text matches a variable already in the value store (e.g. from a preceding `COUNT`), the comparison uses the stored value directly instead of searching the page.

## [0.4.0] - 2026-03-19

### Added

- **Conditional if/then/else steps:** New `IF_VISIBLE`/`IF_CONTAINS`/`IF_URL` planner tokens for inline conditionals. Handle cookie banners, feature flags, and optional UI elements. CLI shows `[then]`/`[else]`/`[skipped]` tags. Both branches cacheable in heuristic plans with drift detection on branch switch.
- **Block conditional YAML syntax:** Multi-step conditional branches using YAML structure (`if:`/`then:`/`else:` keys). Supports multiple steps per branch and optional else. Flattened to inline conditionals at load time, no planner/pilot changes needed.
- **Date/time picker support:** New `DATEPICK` planner token with natural language time parsing ("10 minutes from now", "tomorrow at 3pm"). Automatically detects picker type: native HTML5 inputs, MUI v7 sectioned spinbuttons, or calendar popups. Dates are always computed fresh, cached runs get current timestamps, never stale ones.
- **Remembered value assertions:** New `ASSERT_REMEMBERED` planner token checks that a previously remembered value appears on the page. Enables create/verify workflows: generate a random name, save it, then check it appears in a list.
- **Random test data injection:** Steps containing "random" get seeded with a truly random 6-digit number or a human-readable random string.
- **Partial plan resume:** Failed pilot runs save a partial plan. The next `--pilot` run replays cached steps (fast, no LLM), then switches to pilot mode for the remaining steps. Dramatically speeds up iterative test development.

### Changed

- **Increased robustness with unified page state:** Replaced the disconnected "Accessibility tree" + "Visible page text" dual-section LLM input with a single enriched tree where each element carries its a11y identity, visible text, placeholder, and input value together. 
- **Text-based pilot response format:** Replaced JSON response format with a simple text format (`click ref=e5`, `type ref=e3 value="hello"`, `assert contains_text "Welcome"`). Eliminates JSON syntax errors from LLMs and is easier for models to produce correctly.
- **Spinbutton/date input typing:** Executor detects `role="spinbutton"` and `type="date|datetime-local|time"` inputs and uses `fill()` instead of character-by-character typing, which doesn't work on MUI contentEditable spinbuttons.

### Fixed

- **Chromium crash dialog on macOS:** Browser shutdown now uses CDP `SystemInfo.getProcessInfo` to get the Chrome PID and sends `SIGKILL` directly, bypassing Playwright's `close()` which triggered a SIGSEGV in Chrome 145's shutdown code.
- **Friendly API key error:** Missing `LLM_API_KEY` now shows a helpful message with setup instructions instead of a stack trace.

## [0.3.0] - 2026-03-18

### Added

- **Numeric comparison assertions:** Steps like `check that the count of produkter shown is greater than 0` now work. Supports `greater than`, `less than`, `at least`, `at most`, `equals`, and `not equal` with literal numbers. Works via `assert numeric` in the planner and `COMPARE_VALUE` in the parser.
- **`element_disabled` / `element_enabled` assertion types:** Verify button state with steps like `verify that the "Submit" button is disabled`. Searches multiple interactive roles (button, link, radio, checkbox, tab, menuitem), with polling for `element_enabled` to handle async state changes.
- **Custom radio card support:** Chakra UI radio cards and similar custom components (rendered as `text` nodes inside `radiogroup` in the a11y tree) now get element refs and can be targeted by click actions.
- **Live step progress output:** Step results are now printed as they complete during both discovery and cached runs, instead of all at once after the test finishes.

### Changed

- **Prompt architecture overhaul:** All three LLM prompts (planner, runtime, expander) restructured with consistent section headers, clear decision trees, and inline extension guide. The planner prompt uses classification-first routing for assertions.
- **Page stabilization after every action:** Clicks, types, selects, and other mutating actions now wait for `domcontentloaded` + network idle before proceeding to the next step. Applies to both discovery and cached runs. Eliminates race conditions where pre-resolved assertions ran before the page settled.
- **Real keypresses for all text input:** `type` and `autocomplete` actions now use `page.keyboard.type()` instead of Playwright's `fill()`. This fires real keydown/keypress/input events per character, required for frameworks with per-character rendering (e.g. formatted inputs, live validation). Input clearing uses Cmd/Ctrl+A + Backspace instead of `fill("")`.
- **Force-click on inputs:** The initial focus click for type actions uses `force: true` to bypass actionability checks, handling inputs with decorative icon overlays (search icons, location pins).
- **`pickVisible` checks visibility for single matches:** Locator resolution now verifies even single-match locators are visible before returning, allowing fallback to alternative locator strategies.
- **Locator text fallback uses step hint:** When resolving `text` role nodes (e.g. radio cards), the locator extracts the quoted text from the step instruction for matching, instead of using the full concatenated a11y node name which often mismatches the DOM.
- **Shared quote handling:** `extractQuotedText()` and `stripQuotes()` utilities handle straight and curly quotes consistently across locator resolution, keyword search, and map assertions.
- **Compare assertion resilience:** Falls back to keyword search when the LLM targets the wrong element (e.g. a heading instead of the count), when the element ref is stale, or when the variable name is `"_"` (literal comparison).

### Fixed

- **Disabled button click fails fast:** Clicking a disabled element now throws immediately with a clear error message instead of timing out for 30 seconds.
- **Cached plan preserves `literal` field:** `COMPARE_VALUE` assertions with literal numbers now work correctly in cached runs.
- **Cached plan handles `text` role nodes:** `buildLocator` in the cached runner resolves `text` role elements via `getByText` instead of the invalid `getByRole('text', ...)`.
- **Keyword search proximity matching:** When a number and its label keyword are in separate DOM elements (adjacent lines), the search now finds numbers within 80 characters of a keyword match.
- **Keyword search strips quotes:** Quoted content words in step descriptions (e.g. `'produkter'`) no longer fail keyword matching.

### Documentation

- **Language convention:** Test steps referencing page content must use the same language as the application under test. Added to specifications with good/bad examples.
- **Prompt extension guide:** File-level comments in `prompts.ts` explain how the three prompts relate and provide checklists for adding new actions or assertion types.

## [0.2.0] - 2026-03-17

### Added

- **Map testing support:** Pluggable adapter architecture for testing pages with interactive WebGL maps. Write steps like `check that the map shows "Stockholm"` and GreenLight queries the map's actual rendered features (place names, road labels, etc.) from vector tile data.
- **MapLibre GL JS adapter:** Automatic map instance detection via React fiber tree walking, Vue internals, global variable scanning, and explicit `window.__greenlight_map` exposure.
- **`MAP_DETECT` planner step:** Automatically inserted before map-related steps. Fails the test early if no supported map is found.
- **`map_state` assertion type:** Evaluates conditions against the map's rendered features (name search), viewport state (zoom level checks), and layer visibility. Works in both discovery and cached plan runs.
- **`queryRenderedFeatures` adapter method:** Queries all features visible in the map viewport, used by map assertions to verify map content without coordinates.
- **75% browser zoom in headed mode** via the `playwright-zoom` extension for a better visual overview during test development.
- **Multi-provider LLM support:** Native integrations for OpenRouter, OpenAI, Google Gemini, and Anthropic Claude. Configure via `provider` in `greenlight.yaml` or `--provider` CLI flag. Separate planner/pilot model selection for balancing quality and cost.
- **LLM API error abort:** 4xx and 5xx responses from any LLM provider now abort the entire test run immediately instead of failing individual steps.

### Changed

- **`X-E2E-Test` header is now same-origin only:** Previously added to all requests via `extraHTTPHeaders`, which triggered CORS preflight failures on cross-origin tile servers and CDNs. Now injected per-request via route interception, only on same-origin navigation, fetch, and XHR requests.
- **Headed mode uses persistent browser context,** required for the zoom extension, with pages closed between tests instead of full context teardown.
- **Remember action fallback:** When the LLM targets an element for a `remember` action but the variable name implies a number and the captured text has none, the executor falls back to keyword search in the accessibility tree.

### Fixed

- Cross-origin map tile requests (e.g. PMTiles on DigitalOcean Spaces) no longer fail due to CORS preflight triggered by the `X-E2E-Test` header.

## [0.1.0] - 2026-03-17

Initial NPM release.
