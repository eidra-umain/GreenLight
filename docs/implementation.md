# GreenLight - Implementation Plan

Each step below is self-contained: at the end of the step you can run the app and verify the new functionality works. Every step is built with the final architecture in mind — modules have clear boundaries and are reusable by later steps.

Reference: [specifications.md](./specifications.md) for full feature descriptions and architecture.

---

## Project Structure (target)

This is the directory layout we are building toward. Steps introduce files incrementally — no file is created before it is needed.

```
greenlight/
├── src/
│   ├── cli/                  # CLI entry point and argument parsing
│   │   └── index.ts
│   ├── config.ts             # greenlight.yaml loader, deployment resolution
│   ├── parser/               # YAML suite loading, validation, variable resolution
│   │   ├── schema.ts         # Zod schemas for suite/test/step definitions
│   │   ├── loader.ts         # File reading, YAML parsing, validation
│   │   └── variables.ts      # Variable + env interpolation
│   ├── runner/               # Test orchestration and parallelism
│   │   └── runner.ts
│   ├── pilot/                # The Pilot — core AI agent loop
│   │   ├── pilot.ts          # Step loop: plan → capture → LLM → execute → report
│   │   ├── state.ts          # Page state capture (a11y snapshot + screenshot)
│   │   ├── llm.ts            # LLM client, prompt construction, response parsing
│   │   ├── executor.ts       # Action executor — translates LLM actions to Playwright calls
│   │   └── trace.ts          # Trace logger for performance analysis
│   ├── browser/              # Playwright wrapper
│   │   └── browser.ts        # Browser/context lifecycle, low-level Playwright helpers
│   ├── planner/              # Cached heuristic test plans
│   │   ├── plan-types.ts     # HeuristicStep, HeuristicPlan, PlanMetadata types
│   │   ├── hasher.ts         # SHA-256 hash of effective test definitions
│   │   ├── plan-store.ts     # Read/write plans and hashes in .greenlight/
│   │   ├── plan-generator.ts # Records concrete actions during discovery runs
│   │   └── plan-runner.ts    # Replays cached plans without LLM calls
│   ├── reporter/             # Result collection and output formatting
│   │   ├── types.ts          # Shared result types (StepResult, TestResult, SuiteResult)
│   │   ├── cli-reporter.ts   # Colored terminal output
│   │   ├── json-reporter.ts  # Machine-readable JSON
│   │   └── html-reporter.ts  # HTML report with embedded screenshots
│   └── types.ts              # Shared types across modules
├── tests/                    # GreenLight's own unit/integration tests
├── examples/                 # Example suite YAML files
├── docs/
│   ├── specifications.md
│   └── implementation.md
├── package.json
└── tsconfig.json
```

---

## Step 1 — Project scaffolding and CLI skeleton

**Goal:** `npx greenlight run` parses arguments and prints usage. No browser, no AI — just the CLI frame.

**Modules introduced:**
- `src/cli/index.ts` — argument parsing with a command framework (yargs or commander)
- `src/types.ts` — shared config type (`SuiteConfig`)
- `package.json` / `tsconfig.json` — TypeScript, ESM, build scripts

**What to implement:**
1. Initialize the TypeScript project: `tsconfig.json` with ESM output, strict mode.
2. Add dependencies: `typescript`, `commander` (CLI framework), `dotenv` (env file loading).
3. Create `src/cli/index.ts` with the `run` command accepting all flags from the spec:
   - positional: suite file path(s) (optional, defaults to `./tests/**/*.yaml`)
   - `--test <name>` — filter by test case name
   - `--base-url <url>` — override suite base URL
   - `--reporter <cli|json|html>` — output format (default: `cli`)
   - `--output <path>` — write report to file
   - `--headed` — visible browser
   - `--parallel <n>` — concurrency (default: 1)
   - `--timeout <ms>` — per-step timeout (default: 30000)
   - `--deployment <name>` — select named deployment from greenlight.yaml
   - `--debug` — verbose debug output
   - `--trace` — log timestamped browser events for performance analysis
4. Wire up `bin` entry in `package.json` so `npx greenlight` works.
5. Add `src/config.ts` — loads optional `greenlight.yaml` from project root. Supports `suites` (glob patterns), deployment configs, and config field merging (CLI flags > deployment > top-level > defaults).
5. The `run` handler should parse args, print the resolved config, and exit. No actual execution yet.

**Verify:**
```bash
npx greenlight run --help
npx greenlight run examples/demo.yaml --headed --parallel 2
# → prints parsed config and exits
```

---

## Step 2 — YAML parser and suite loader

**Goal:** `npx greenlight run examples/demo.yaml` loads, validates, and prints a parsed suite.

**Modules introduced:**
- `src/parser/schema.ts` — Zod schemas defining Suite, TestCase, Step, ReusableStep, Variables
- `src/parser/loader.ts` — reads YAML files, validates against schema, returns typed objects
- `src/parser/variables.ts` — resolves `{{var}}` and `{{env.VAR}}` references
- `examples/demo.yaml` — a minimal example suite

**What to implement:**
1. Define Zod schemas matching the spec's YAML format:
   - `SuiteSchema`: `suite`, `base_url?` (optional — can come from greenlight.yaml or CLI), `viewport?`, `model?`, `variables?`, `reusable_steps?`, `tests`
   - `TestCaseSchema`: `name`, `description?`, `steps`
   - Steps are plain strings at this stage.
2. `loader.ts`: reads file, parses YAML (`yaml` package), validates with Zod, returns typed `Suite`.
3. `variables.ts`: scans strings for `{{name}}` patterns, resolves from suite variables and `process.env`. Supports `{{env.X}}` and `{{timestamp}}`.
4. Expand reusable steps: when a step string matches a reusable step name, inline its steps.
5. CLI `run` handler now calls the loader, resolves variables, and pretty-prints the parsed suite.
6. Create `examples/demo.yaml` with a simple suite (2-3 test cases against a public site).

**Verify:**
```bash
npx greenlight run examples/demo.yaml
# → prints the fully resolved suite with expanded reusable steps and variables
```

---

## Step 3 — Browser module and page state capture

**Goal:** `npx greenlight run examples/demo.yaml` opens a browser, navigates to `base_url`, captures an a11y snapshot and screenshot, prints them, and exits.

**Modules introduced:**
- `src/browser/browser.ts` — Playwright browser lifecycle: launch, create context, create page, close
- `src/pilot/state.ts` — captures page state: a11y tree snapshot + screenshot + console logs
- `src/reporter/types.ts` — `PageState` type definition

**What to implement:**
1. `browser.ts`:
   - `launchBrowser(config)` — launches Chromium (headless/headed based on config).
   - `createContext(browser, config)` — creates a Browser Context with viewport settings.
   - `createPage(context)` — creates a new page within a context.
   - `closeBrowser(browser)` — cleanup.
2. `state.ts`:
   - `attachConsoleCollector(page)` — attaches a console event listener and returns a `drain()` function that retrieves and clears collected entries.
   - `capturePageState(page, consoleDrain, options?)` — returns:
     - `a11yTree`: Playwright's `page.locator("body").ariaSnapshot()` result, parsed into a tree of `A11yNode` objects with element refs assigned.
     - `a11yRaw`: the raw aria snapshot text.
     - `screenshot`: optional base64 PNG of the viewport (only captured when `options.screenshot` is true — skipped on pre-action captures to avoid triggering lazy-loaded elements).
     - `url`: current page URL.
     - `title`: page title.
     - `consoleLogs`: console messages from the drain.
   - `parseA11ySnapshot(raw)` — parses the YAML-like ariaSnapshot output into a tree of `A11yNode` objects. Interactive roles (link, button, textbox, etc.) get sequential refs (`e1`, `e2`, ...); non-interactive structural roles get pseudo-refs (`_role`).
   - `formatA11yTree(nodes)` — formats the parsed tree as readable text for LLM consumption and debug output.
3. CLI `run` handler now: loads suite → launches browser → navigates to `base_url` → calls `capturePageState` → prints the a11y snapshot and saves the screenshot to disk → closes browser.

**Verify:**
```bash
npx greenlight run examples/demo.yaml
# → opens browser, navigates, prints a11y tree with element refs, saves screenshot.png

npx greenlight run examples/demo.yaml --headed
# → same but with a visible browser window
```

---

## Step 4 — LLM client and structured action parsing

**Goal:** Given a step and page state, the LLM returns a structured action. Verifiable by running a single hardcoded step against a live page. The LLM layer is provider-agnostic, using the OpenAI-compatible chat completions API via OpenRouter so any model can be swapped in.

**Modules introduced:**
- `src/pilot/llm.ts` — provider-agnostic LLM client: prompt construction, API call, response parsing

**What to implement:**
1. `llm.ts`:
   - `createLLMClient(config): LLMClient` — returns a client that talks to an OpenAI-compatible endpoint (default: OpenRouter). No vendor SDK — uses plain `fetch` against the `/chat/completions` endpoint. Configuration:
     - `apiKey` — from `OPENROUTER_API_KEY` env var (or `LLM_API_KEY` as a generic fallback).
     - `baseUrl` — defaults to `https://openrouter.ai/api/v1` but overridable for any OpenAI-compatible provider (e.g., direct OpenAI, local Ollama, etc.).
     - `model` — configurable per suite in YAML (`model` field) or via CLI `--model` flag. Default: `anthropic/claude-sonnet-4` via OpenRouter.
   - The `LLMClient` interface has three methods:
     - `planSteps(steps[]): PlannedStep[]` — sends all test steps to the LLM in one request with a planning system prompt (`PLAN_SYSTEM_PROMPT`). The LLM returns a line-based format where each step is either a pre-resolved action (assert, navigate, press, scroll) or a `PAGE "description"` marker for steps needing runtime resolution. Compound steps may be split into multiple atomic actions.
     - `resolveStep(step, pageState): Action` — for page-dependent steps: sends the step + formatted a11y tree to the LLM with the execution system prompt (`SYSTEM_PROMPT`). Maintains conversation history within a test case for context. Caches results for identical step+URL combinations.
     - `resetHistory()` — clears conversation history (called between test cases).
   - `parseActionResponse(raw)` — parses LLM JSON response into a typed `Action` object: `{ action, ref?, text?, value?, assertion? }`. Strips markdown code fences. Validates action type against allowed list. The `text` field allows targeting elements by visible text when they lack ARIA markup.
   - `parsePlanResponse(raw)` — parses the line-based planning output into `PlannedStep[]`.
2. Define the `Action` type (in `reporter/types.ts`) and system prompt templates as clear, versionable constants.
3. `model` field already added to `SuiteSchema` (optional, overridable) and `--model` flag to CLI in prior steps.
4. Temporary test harness in the CLI: loads suite → opens browser → navigates → captures state → sends the first step of the first test to the LLM → prints the returned action → exits.

**Verify:**
```bash
OPENROUTER_API_KEY=sk-... npx greenlight run examples/demo.yaml
# → navigates to base_url
# → captures a11y snapshot
# → sends first step to configured model via OpenRouter
# → prints the structured action returned (e.g. { action: "click", ref: "e5" })

# Override model from CLI:
OPENROUTER_API_KEY=sk-... npx greenlight run examples/demo.yaml --model openai/gpt-4o

# Use a different OpenAI-compatible provider:
LLM_API_KEY=sk-... npx greenlight run examples/demo.yaml \
  --llm-base-url http://localhost:11434/v1 \
  --model llama3
```

---

## Step 5 — Action executor

**Goal:** The LLM's structured action is executed in the browser. A single step runs end-to-end: capture → LLM → execute → capture post-state.

**Modules introduced:**
- `src/pilot/executor.ts` — translates `Action` objects into Playwright calls

**What to implement:**
1. `executor.ts`:
   - `executeAction(page, action, a11yTree): ExecutionResult` — switch on `action.action`:
     - `click` — resolve target locator, click with navigation handling.
     - `type` — resolve target, click to focus, clear with Ctrl+A + Backspace, type character-by-character with 30ms delay for proper JS event triggering.
     - `select` — resolve target, `selectOption({ label })`.
     - `scroll` — if ref provided, `scrollIntoViewIfNeeded()`; otherwise `page.mouse.wheel(0, ±500)`.
     - `navigate` — `page.goto(url, { waitUntil: "domcontentloaded" })`. Resolves relative paths against current URL.
     - `wait` — `page.getByText(value).waitFor({ state: "visible" })`.
     - `press` — `page.keyboard.press(key)` with navigation handling.
     - `assert` — calls `executeAssertion()` which evaluates assertions directly (no LLM needed).
   - **Multi-strategy locator resolution** (`resolveLocator`): given a ref and the a11y tree, tries locators in order: (1) chained hierarchy through named ancestors, (2) direct `getByRole(role, { name, exact: true })`, (3) `getByLabel(name)`, (4) `getByPlaceholder(name)`, (5) loose `getByRole(role, { name })`. Returns first locator matching a single visible element.
   - **Text fallback** (`resolveByText`): when the action has a `text` field instead of `ref`, locates elements by visible text using `getByRole("link"/"button")` and `getByText` with exact and loose matching.
   - **Navigation handling** (`runWithNavigationHandling`): wraps click/press actions. Listens for `framenavigated` events; if triggered, waits for `domcontentloaded`.
   - **Assertion evaluation**: positive assertions (contains_text, element_visible, link_exists, field_exists) are polled with 250ms intervals up to 5s timeout. Negative assertions (not_contains_text, element_not_visible) and URL checks run once immediately.
   - Returns `ExecutionResult`: `{ success, duration, error? }`.
2. Wire into the CLI: loads suite → opens browser → navigates → for the first step: capture → LLM → execute → capture post-state → print before/after → exits.

**Verify:**
```bash
OPENROUTER_API_KEY=sk-... npx greenlight run examples/demo.yaml --headed
# → opens browser, navigates
# → executes the first step of the first test (e.g. clicks a button)
# → prints the action taken and the result
# → visible in the headed browser
```

---

## Step 6 — The Pilot loop

**Goal:** A single test case runs all its steps sequentially. The Pilot loops through steps, executing each one, and reports pass/fail per step.

**Modules introduced:**
- `src/pilot/pilot.ts` — the core Pilot loop: iterates steps, manages state between steps

**What to implement:**
1. `pilot.ts`:
   - `runTestCase(page, testCase, llm, options): TestCaseResult` — the LLM client is injected (not created internally). `PilotOptions` includes: `timeout`, `consoleDrain`, `debug`, and optional `trace` (TraceLogger).
   - **Planning phase**: calls `llm.planSteps(testCase.steps)` to pre-plan all steps. If planning fails, falls back to runtime resolution for all steps. Debug mode prints the plan input and output.
   - **Execution phase** — for each planned step:
     1. If action was pre-resolved (from planning): execute directly, skip capture and LLM.
     2. If needs page state: reset ref counter, capture a11y tree via `capturePageState()` (without screenshot), send to `llm.resolveStep()`, get action.
     3. Execute action via `executeAction()`. Assertions are evaluated directly by the executor (not by the LLM).
     4. On failure: record failed step result and break (fail-fast).
     5. On success: capture post-action screenshot for reporting. If page is mid-navigation, wait for `domcontentloaded` and retry capture.
     6. Record `StepResult`: `{ step, action, status, duration, timing?, screenshot?, error? }`.
   - `StepTiming` tracks per-phase breakdown: capture, llm, execute, postCapture (all in ms).
   - Returns `TestCaseResult`: `{ name, status, steps: StepResult[], duration }`.
2. `trace.ts` — optional trace logger enabled with `--trace`:
   - `createTraceLogger(enabled)` — returns TraceLogger (no-op if disabled).
   - `log(event, detail?)` — logs timestamped events.
   - `attachToPage(page)` / `detachFromPage(page)` — listens for page events (framenavigated, load, domcontentloaded, request/response for document/xhr/fetch, console errors). Filters noise from media files and tracking domains.
3. CLI now runs all steps of all test cases (iterating tests within a suite) and prints step-by-step results with timing breakdowns. Each test case gets a fresh browser context. The LLM history is reset between test cases.

**Verify:**
```bash
OPENROUTER_API_KEY=sk-... npx greenlight run examples/demo.yaml --headed
# → runs all steps of all test cases
# → prints per-step pass/fail with timing breakdowns
# → stops on first failure within each test case
# → prints PASSED/FAILED per test with total duration

OPENROUTER_API_KEY=sk-... npx greenlight run examples/demo.yaml --debug
# → also prints plan input/output, a11y trees, and action JSON

OPENROUTER_API_KEY=sk-... npx greenlight run examples/demo.yaml --trace
# → also prints timestamped browser events
```

---

## Step 7 — Cached heuristic test plans

**Goal:** After a successful LLM-driven test run (discovery run), GreenLight generates and caches a heuristic test plan — a concrete, element-bound action sequence that can be replayed without LLM calls. Subsequent runs use the cached plan for fast execution. Changes to the source test definition (detected via SHA-256 hash) trigger a fresh discovery run.

**Modules introduced:**
- `src/planner/plan-types.ts` — types for heuristic plans (`HeuristicStep`, `HeuristicPlan`, `PlanMetadata`)
- `src/planner/hasher.ts` — computes SHA-256 hash of a test case's effective definition (post variable/reusable-step expansion)
- `src/planner/plan-store.ts` — reads/writes plan files and `hashes.json` in `.greenlight/plans/`
- `src/planner/plan-generator.ts` — hooks into the Pilot loop to record concrete actions during a discovery run and produce a `HeuristicPlan`
- `src/planner/plan-runner.ts` — replays a cached `HeuristicPlan` directly via Playwright (no LLM)

**What to implement:**

1. `plan-types.ts`:
   - `HeuristicStep`: `{ originalStep: string, action: string, selector: { role, name, exact? }, value?: string, assertion?: { type, selector, expected }, postStepFingerprint: { url, title, keyElements: string[] } }`.
   - `HeuristicPlan`: `{ suiteSlug: string, testSlug: string, sourceHash: string, model: string, generatedAt: string, greenlightVersion: string, steps: HeuristicStep[] }`.

2. `hasher.ts`:
   - `computeTestHash(testCase, suiteVariables, reusableSteps): string` — takes the fully resolved test case (after variable interpolation and reusable step expansion), serializes it deterministically, and returns its SHA-256 hash.

3. `plan-store.ts`:
   - `loadHashIndex(projectRoot): Record<string, string>` — reads `.greenlight/hashes.json`.
   - `saveHashIndex(projectRoot, index)` — writes the hash index.
   - `loadPlan(projectRoot, suiteSlug, testSlug): HeuristicPlan | null` — reads a cached plan file.
   - `savePlan(projectRoot, plan)` — writes a plan file to `.greenlight/plans/{suiteSlug}/{testSlug}.json`.
   - `deletePlan(projectRoot, suiteSlug, testSlug)` — removes a stale plan.
   - Slug generation: kebab-case from suite/test names.

4. `plan-generator.ts`:
   - `createPlanRecorder(testCase, suiteConfig): PlanRecorder` — returns a recorder that the Pilot calls after each step.
   - `recorder.recordStep(step, action, resolvedSelector, postPageState)` — captures the concrete selector (role + name extracted from the a11y node that was acted upon), the action, and a post-step fingerprint.
   - `recorder.finalize(): HeuristicPlan` — produces the complete plan with metadata and source hash.
   - Integrates with `pilot.ts`: after each successful step execution, call the recorder. On test case completion, finalize and save the plan.

5. `plan-runner.ts`:
   - `runCachedPlan(page, plan, config): TestCaseResult` — for each `HeuristicStep`:
     1. Build a Playwright locator from `selector` (e.g., `page.getByRole(role, { name })`).
     2. Execute the action directly (click, fill, etc.) — no LLM involved.
     3. For assertion steps: evaluate the concrete assertion against the page.
     4. Validate the post-step fingerprint. On significant drift (element not found, unexpected URL), mark the step as a **plan drift** failure.
   - Returns a `TestCaseResult` with a `mode: "cached"` indicator.

6. Update `pilot.ts`:
   - Accept an optional `PlanRecorder` and call it during step execution.
   - After a successful test case run in discovery mode, save the plan via `plan-store.ts`.

7. Update the CLI / run logic:
   - Before running a test case, compute its source hash and check against `hashes.json`.
   - If a valid cached plan exists → use `plan-runner.ts` (fast run).
   - If no plan or hash mismatch → use the full Pilot loop (discovery run), then save the new plan.
   - Add CLI flags:
     - `--discover` — force discovery run, ignore cached plans.
     - `--on-drift <fail|rerun>` — behavior on plan drift (default: `fail`).
     - `--plan-status` — print cache status for all test cases and exit.

8. Create `.greenlight/` directory structure on first discovery run. Add `.greenlight/` to the project's `.gitignore` if it exists.

**Verify:**
```bash
# First run: discovery mode (no cached plans exist)
OPENROUTER_API_KEY=sk-... npx greenlight run examples/demo.yaml --headed
# → runs all steps via LLM
# → saves heuristic plans to .greenlight/plans/
# → prints "Cached plan generated for: User can complete checkout"

# Second run: fast mode (cached plans used)
npx greenlight run examples/demo.yaml
# → runs without LLM calls, significantly faster
# → prints "Using cached plan for: User can complete checkout"

# Modify a step in the YAML, then run again
npx greenlight run examples/demo.yaml
# → detects hash mismatch for modified test case
# → runs discovery for that test case, fast run for unchanged ones
# → prints "Plan stale, re-discovering: User can complete checkout"

# Force discovery run
OPENROUTER_API_KEY=sk-... npx greenlight run examples/demo.yaml --discover
# → ignores all cached plans, runs full LLM loop

# Check plan status
npx greenlight run examples/demo.yaml --plan-status
# → demo-flow/user-can-complete-checkout: cached (hash: abc123, generated: 2025-01-15)
# → demo-flow/user-sees-error: no cached plan
```

---

## Step 8 — Test runner and multi-test orchestration

**Goal:** `npx greenlight run` executes all test cases in a suite (sequentially), reports results for each.

**Modules introduced:**
- `src/runner/runner.ts` — orchestrates multiple test cases, manages browser lifecycle

**What to implement:**
1. `runner.ts`:
   - `runSuite(suite, config): SuiteResult` — for each test case:
     1. Create a fresh Browser Context (isolated cookies/storage).
     2. Create a page, navigate to `base_url`.
     3. Check for a valid cached plan; if available, use `plan-runner.ts`, otherwise instantiate a Pilot and call `runTestCase`.
     4. Close the context.
     5. Collect `TestCaseResult`.
   - Returns `SuiteResult`: `{ suite, results: TestCaseResult[], duration, passed, failed }`.
   - `--test` filter: if provided, only run matching test cases.
2. CLI wires it all together: parse args → load suite → launch browser → run suite → print summary → exit with code 0/1.

**Verify:**
```bash
OPENROUTER_API_KEY=sk-... npx greenlight run examples/demo.yaml
# → runs all test cases in the suite sequentially
# → uses cached plans where available, discovery runs otherwise
# → prints per-test and per-step results
# → exits 0 if all pass, 1 if any fail

npx greenlight run examples/demo.yaml --test "User can search"
# → runs only the named test case
```

---

## Step 9 — CLI reporter

**Goal:** Polished terminal output with colors, icons, and a clear summary.

**Modules introduced:**
- `src/reporter/cli-reporter.ts` — colored terminal output

**What to implement:**
1. `cli-reporter.ts`:
   - Formats `SuiteResult` for terminal display using chalk (or picocolors for zero-dependency):
     - Suite header with name and base URL.
     - Per test case: name, pass/fail icon, duration.
     - Per step (on failure or verbose mode): step text, action taken, error message.
     - Summary footer: X passed, Y failed, total duration.
   - Verbose mode (`--verbose` flag, add to CLI): show every step's action and timing even on pass.
2. Wire into CLI as the default reporter.

**Verify:**
```bash
OPENROUTER_API_KEY=sk-... npx greenlight run examples/demo.yaml
# → clean, colored output:
#   Suite: Demo Flow
#   ✓ User can search (4.2s)
#   ✗ User can checkout (8.1s)
#     Step 5: check that page contains "Order Confirmed"
#     Expected page to contain "Order Confirmed" but it was not found.
#   1 passed, 1 failed (12.3s)
```

---

## Step 10 — JSON reporter

**Goal:** `--reporter json` outputs machine-readable results.

**Modules introduced:**
- `src/reporter/json-reporter.ts`

**What to implement:**
1. `json-reporter.ts`:
   - Serializes `SuiteResult` to JSON including: suite name, base URL, each test case with status/duration, each step with action/status/duration/error.
   - Screenshots are referenced as file paths (not inlined as base64 in JSON).
   - Writes to `--output` path if given, otherwise prints to stdout.
2. Wire into CLI via `--reporter json`.

**Verify:**
```bash
OPENROUTER_API_KEY=sk-... npx greenlight run examples/demo.yaml --reporter json --output results.json
cat results.json | jq '.results[0].status'
# → "passed"
```

---

## Step 11 — Parallel execution

**Goal:** `--parallel N` runs N test cases concurrently within a suite.

**Modules changed:**
- `src/runner/runner.ts` — adds concurrency control

**What to implement:**
1. Update `runSuite` to accept a `parallel` option.
2. Use a concurrency limiter (e.g., `p-limit`) to run up to N test cases simultaneously.
3. Each parallel test case gets its own Browser Context (shared Chromium process).
4. Result collection remains ordered by test case definition order.
5. CLI reporter handles interleaved completion gracefully (buffers output, prints in order).

**Verify:**
```bash
OPENROUTER_API_KEY=sk-... npx greenlight run examples/demo.yaml --parallel 4 --headed
# → 4 browser tabs open simultaneously, each running a test case
# → results printed in definition order after all complete
# → total wall time is significantly less than sequential
```

---

## Step 12 — HTML reporter

**Goal:** `--reporter html` generates a self-contained HTML report with embedded screenshots.

**Modules introduced:**
- `src/reporter/html-reporter.ts`

**What to implement:**
1. `html-reporter.ts`:
   - Generates a single `.html` file (no external dependencies) containing:
     - Suite summary (name, URL, pass/fail counts, duration).
     - Collapsible test cases with step-by-step timeline.
     - Embedded screenshots (base64 inline) at each step.
     - Pilot reasoning trace per step (collapsible).
     - Failure details highlighted.
   - Uses inline CSS for styling (clean, minimal design).
2. Wire into CLI via `--reporter html`.

**Verify:**
```bash
OPENROUTER_API_KEY=sk-... npx greenlight run examples/demo.yaml --reporter html --output report.html
open report.html
# → visual report with screenshots, pass/fail status, expandable step details
```

---

## Step 13 — Retry logic and robustness

**Goal:** Transient failures are retried automatically. Step timeouts are enforced.

**Modules changed:**
- `src/pilot/pilot.ts` — retry wrapper around step execution
- `src/pilot/executor.ts` — timeout enforcement

**What to implement:**
1. Wrap each step execution in a retry loop (configurable, default: 2 retries):
   - On Playwright timeout or element-not-found: re-capture page state and retry the full LLM → execute cycle.
   - On LLM malformed response: re-prompt with error context.
   - On assertion failure: no retry (assertions are deterministic).
2. Per-step timeout: if the full capture → LLM → execute cycle exceeds `--timeout`, fail the step.
3. Log retries in the step result so reports show "passed on retry 2 of 3".

**Verify:**
```bash
# Create a test against a slow-loading page
OPENROUTER_API_KEY=sk-... npx greenlight run examples/retry-demo.yaml --headed --timeout 15000
# → step that initially can't find element retries after a wait and succeeds
# → CLI output shows "(retry 1/2)"
```

---

## Step 14 — Environment variables, secrets, and cookie injection

**Goal:** Credentials sourced from env vars, sensitive values redacted in output, optional cookie-based auth.

**Modules changed:**
- `src/parser/variables.ts` — `{{env.X}}` support (already scaffolded in step 2, now tested)
- `src/reporter/*.ts` — redaction of secret values
- `src/browser/browser.ts` — cookie injection API

**What to implement:**
1. Ensure `{{env.X}}` resolution works end-to-end (suite variable references an env var, used in a step, executed correctly).
2. Add `secrets` list to suite config: variable names whose values should be redacted in all output.
3. All reporters: replace secret values with `[REDACTED]` in step text, action logs, error messages, and reasoning traces.
4. `browser.ts`: add `injectCookies(context, cookies[])` — sets cookies before navigation for session-based auth.
5. Suite config supports an optional `cookies` field for pre-authenticated sessions.

**Verify:**
```bash
ADMIN_PASSWORD=s3cret OPENROUTER_API_KEY=sk-... npx greenlight run examples/auth-demo.yaml
# → step uses env var password
# → CLI output shows 'enter "[REDACTED]" into "Password"'
# → JSON report does not contain the actual password
```

---

## Summary

| Step | What you can run | Key modules |
|------|-----------------|-------------|
| 1 | `greenlight run --help` | cli |
| 2 | `greenlight run demo.yaml` → prints parsed suite | parser |
| 3 | `greenlight run demo.yaml` → opens browser, captures a11y + screenshot | browser, pilot/state |
| 4 | `greenlight run demo.yaml` → sends step to LLM, prints action | pilot/llm |
| 5 | `greenlight run demo.yaml` → executes one step in browser | pilot/executor |
| 6 | `greenlight run demo.yaml` → runs all steps of one test | pilot/pilot |
| 7 | `greenlight run demo.yaml` → caches heuristic plans, fast re-runs | planner |
| 8 | `greenlight run demo.yaml` → runs all tests in suite | runner |
| 9 | `greenlight run demo.yaml` → polished CLI output | reporter/cli |
| 10 | `greenlight run demo.yaml --reporter json` | reporter/json |
| 11 | `greenlight run demo.yaml --parallel 4` | runner (concurrency) |
| 12 | `greenlight run demo.yaml --reporter html` | reporter/html |
| 13 | Transient failures auto-retry | pilot (retry) |
| 14 | `{{env.X}}`, secrets redaction, cookie auth | parser, reporter, browser |
