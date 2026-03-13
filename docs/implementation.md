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
│   ├── parser/               # YAML suite loading, validation, variable resolution
│   │   ├── schema.ts         # Zod schemas for suite/test/step definitions
│   │   ├── loader.ts         # File reading, YAML parsing, validation
│   │   └── variables.ts      # Variable + env interpolation
│   ├── runner/               # Test orchestration and parallelism
│   │   └── runner.ts
│   ├── pilot/                # The Pilot — core AI agent loop
│   │   ├── pilot.ts          # Step loop: capture → LLM → execute → report
│   │   ├── state.ts          # Page state capture (a11y snapshot + screenshot)
│   │   ├── llm.ts            # Claude API client, prompt construction, response parsing
│   │   └── executor.ts       # Action executor — translates LLM actions to Playwright calls
│   ├── browser/              # Playwright wrapper
│   │   └── browser.ts        # Browser/context lifecycle, low-level Playwright helpers
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
2. Add dependencies: `typescript`, `commander` (lightweight CLI framework).
3. Create `src/cli/index.ts` with the `run` command accepting all flags from the spec:
   - positional: suite file path(s) (optional, defaults to `./tests/**/*.yaml`)
   - `--test <name>` — filter by test case name
   - `--base-url <url>` — override suite base URL
   - `--reporter <cli|json|html>` — output format (default: `cli`)
   - `--output <path>` — write report to file
   - `--headed` — visible browser
   - `--parallel <n>` — concurrency (default: 1)
   - `--timeout <ms>` — per-step timeout
4. Wire up `bin` entry in `package.json` so `npx greenlight` works.
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
   - `SuiteSchema`: `suite`, `base_url`, `viewport?`, `variables?`, `reusable_steps?`, `tests`
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
   - `capturePageState(page): PageState` — returns:
     - `a11ySnapshot`: Playwright's `page.accessibility.snapshot()` result, serialized to a readable format with element refs assigned.
     - `screenshot`: base64 PNG of the viewport.
     - `url`: current page URL.
     - `title`: page title.
     - `consoleLogs`: any console messages captured since last call.
   - Element ref assignment: traverse the a11y tree and assign sequential `ref` IDs (`e1`, `e2`, ...) to each interactive node.
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

**Goal:** Given a step and page state, the LLM returns a structured action. Verifiable by running a single hardcoded step against a live page.

**Modules introduced:**
- `src/pilot/llm.ts` — Claude API client: prompt construction, API call, response parsing

**What to implement:**
1. `llm.ts`:
   - `createLLMClient(config)` — initializes the Anthropic SDK client.
   - `resolveStep(step, pageState, config): Action` — constructs a prompt containing:
     - System prompt: the Pilot's persona, the list of available actions (click, type, select, scroll, navigate, wait, assert, etc.), and the expected JSON response format.
     - User message: the plain-English step + the a11y snapshot (as text). Screenshot attached as an image only if configured or a11y-only resolution fails.
   - Parses the LLM response into a typed `Action` object: `{ action: string, ref?: string, value?: string, assertion?: object }`.
   - Handles retries on malformed responses (re-prompt with clarification).
2. Define the `Action` type and the system prompt template in clear, versionable constants.
3. Temporary test harness in the CLI: loads suite → opens browser → navigates → captures state → sends the first step of the first test to the LLM → prints the returned action → exits.

**Verify:**
```bash
ANTHROPIC_API_KEY=sk-... npx greenlight run examples/demo.yaml
# → navigates to base_url
# → captures a11y snapshot
# → sends first step to Claude
# → prints the structured action returned (e.g. { action: "click", ref: "e5" })
```

---

## Step 5 — Action executor

**Goal:** The LLM's structured action is executed in the browser. A single step runs end-to-end: capture → LLM → execute → capture post-state.

**Modules introduced:**
- `src/pilot/executor.ts` — translates `Action` objects into Playwright calls

**What to implement:**
1. `executor.ts`:
   - `executeAction(page, action, a11ySnapshot): ExecutionResult` — switch on `action.action`:
     - `click` — resolve `action.ref` to a Playwright locator via the a11y snapshot (find the node by ref, use its role + name to build `page.getByRole(...)`), then click.
     - `type` / `enter` — resolve target field by ref, clear if needed, type `action.value`.
     - `select` — resolve select element, select option by label.
     - `scroll` — `page.mouse.wheel()` or scroll to element.
     - `navigate` — `page.goto(action.value)` or `page.goBack()`.
     - `wait` — `page.waitForSelector` / `page.waitForTimeout` based on action params.
     - `press` — `page.keyboard.press(action.value)`.
   - Ref resolution helper: given a ref ID and the a11y tree, return the matching Playwright locator. Uses the node's `role` and `name` to construct `page.getByRole(role, { name })`.
   - Returns `ExecutionResult`: `{ success, duration, error? }`.
2. Wire into the CLI: loads suite → opens browser → navigates → for the first step: capture → LLM → execute → capture post-state → print before/after → exits.

**Verify:**
```bash
ANTHROPIC_API_KEY=sk-... npx greenlight run examples/demo.yaml --headed
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
   - `runTestCase(page, testCase, config): TestCaseResult` — for each step:
     1. Capture page state (`state.ts`).
     2. Send step + state to LLM (`llm.ts`).
     3. Execute returned action (`executor.ts`).
     4. Capture post-action screenshot (for reporting).
     5. For assertion steps: evaluate the assertion against the post-action state (check page contains text, check element value, etc.).
     6. Record `StepResult`: `{ step, action, status, duration, screenshot, error?, reasoning }`.
     7. On failure: stop remaining steps in this test case (fail-fast).
   - Returns `TestCaseResult`: `{ name, status, steps: StepResult[], duration }`.
2. Handle assertion steps: the LLM is asked to evaluate assertions against the page state and return `{ action: "assert", pass: boolean, reason: string }`.
3. Handle vision fallback: if the LLM responds with low confidence or requests a screenshot, re-send with the screenshot attached.
4. CLI now runs all steps of the first test case and prints step-by-step results.

**Verify:**
```bash
ANTHROPIC_API_KEY=sk-... npx greenlight run examples/demo.yaml --headed
# → runs all steps of the first test case
# → prints per-step pass/fail with action details
# → stops on first failure with error explanation
```

---

## Step 7 — Test runner and multi-test orchestration

**Goal:** `npx greenlight run` executes all test cases in a suite (sequentially), reports results for each.

**Modules introduced:**
- `src/runner/runner.ts` — orchestrates multiple test cases, manages browser lifecycle

**What to implement:**
1. `runner.ts`:
   - `runSuite(suite, config): SuiteResult` — for each test case:
     1. Create a fresh Browser Context (isolated cookies/storage).
     2. Create a page, navigate to `base_url`.
     3. Instantiate a Pilot and call `runTestCase`.
     4. Close the context.
     5. Collect `TestCaseResult`.
   - Returns `SuiteResult`: `{ suite, results: TestCaseResult[], duration, passed, failed }`.
   - `--test` filter: if provided, only run matching test cases.
2. CLI wires it all together: parse args → load suite → launch browser → run suite → print summary → exit with code 0/1.

**Verify:**
```bash
ANTHROPIC_API_KEY=sk-... npx greenlight run examples/demo.yaml
# → runs all test cases in the suite sequentially
# → prints per-test and per-step results
# → exits 0 if all pass, 1 if any fail

npx greenlight run examples/demo.yaml --test "User can search"
# → runs only the named test case
```

---

## Step 8 — CLI reporter

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
ANTHROPIC_API_KEY=sk-... npx greenlight run examples/demo.yaml
# → clean, colored output:
#   Suite: Demo Flow
#   ✓ User can search (4.2s)
#   ✗ User can checkout (8.1s)
#     Step 5: check that page contains "Order Confirmed"
#     Expected page to contain "Order Confirmed" but it was not found.
#   1 passed, 1 failed (12.3s)
```

---

## Step 9 — JSON reporter

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
ANTHROPIC_API_KEY=sk-... npx greenlight run examples/demo.yaml --reporter json --output results.json
cat results.json | jq '.results[0].status'
# → "passed"
```

---

## Step 10 — Parallel execution

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
ANTHROPIC_API_KEY=sk-... npx greenlight run examples/demo.yaml --parallel 4 --headed
# → 4 browser tabs open simultaneously, each running a test case
# → results printed in definition order after all complete
# → total wall time is significantly less than sequential
```

---

## Step 11 — HTML reporter

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
ANTHROPIC_API_KEY=sk-... npx greenlight run examples/demo.yaml --reporter html --output report.html
open report.html
# → visual report with screenshots, pass/fail status, expandable step details
```

---

## Step 12 — Retry logic and robustness

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
ANTHROPIC_API_KEY=sk-... npx greenlight run examples/retry-demo.yaml --headed --timeout 15000
# → step that initially can't find element retries after a wait and succeeds
# → CLI output shows "(retry 1/2)"
```

---

## Step 13 — Environment variables, secrets, and cookie injection

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
ADMIN_PASSWORD=s3cret ANTHROPIC_API_KEY=sk-... npx greenlight run examples/auth-demo.yaml
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
| 7 | `greenlight run demo.yaml` → runs all tests in suite | runner |
| 8 | `greenlight run demo.yaml` → polished CLI output | reporter/cli |
| 9 | `greenlight run demo.yaml --reporter json` | reporter/json |
| 10 | `greenlight run demo.yaml --parallel 4` | runner (concurrency) |
| 11 | `greenlight run demo.yaml --reporter html` | reporter/html |
| 12 | Transient failures auto-retry | pilot (retry) |
| 13 | `{{env.X}}`, secrets redaction, cookie auth | parser, reporter, browser |
