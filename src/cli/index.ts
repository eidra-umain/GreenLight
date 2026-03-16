#!/usr/bin/env node

import "dotenv/config"
import { Command } from "commander"
import { DEFAULTS, type RunConfig } from "../types.js"
import { loadProjectConfig } from "../config.js"
import { loadSuite } from "../parser/loader.js"
import {
	launchBrowser,
	createContext,
	createPage,
	closeBrowser,
	toBrowserOptions,
} from "../browser/browser.js"
import {
	attachConsoleCollector,
	attachNetworkTracker,
} from "../pilot/state.js"
import {
	resolveLLMConfig,
	createLLMClient,
	type LLMClient,
} from "../pilot/llm.js"
import { runTestCase } from "../pilot/pilot.js"
import { createTraceLogger } from "../pilot/trace.js"
import { resolve } from "node:path"
import { glob } from "node:fs"
import { computeTestHash, slugify } from "../planner/hasher.js"
import {
	loadHashIndex,
	saveHashIndex,
	loadPlan,
	savePlan,
	ensureGitignore,
} from "../planner/plan-store.js"
import { createPlanRecorder } from "../planner/plan-generator.js"
import { runCachedPlan } from "../planner/plan-runner.js"
import type { TestCaseResult } from "../reporter/types.js"
import { initGlobals, globals } from "../globals.js"

const program = new Command()

program
	.name("greenlight")
	.description("AI-driven E2E testing tool")
	.version("0.1.0")

program
	.command("run")
	.description("Run test suites against a staging environment")
	.argument(
		"[suites...]",
		"paths to suite YAML files (overrides greenlight.yaml)",
	)
	.option("-t, --test <name>", "run only the test case matching this name")
	.option("--base-url <url>", "override the suite base URL")
	.option("-r, --reporter <format>", "output format: cli, json, or html")
	.option("-o, --output <path>", "write report to file instead of stdout")
	.option("--headed", "run browser in visible (headed) mode")
	.option("-p, --parallel <n>", "number of test cases to run concurrently")
	.option("--timeout <ms>", "per-step timeout in milliseconds")
	.option(
		"--model <model>",
		"LLM model identifier (e.g. anthropic/claude-sonnet-4)",
	)
	.option("--llm-base-url <url>", "base URL for the OpenAI-compatible LLM API")
	.option(
		"-d, --deployment <name>",
		"select a named deployment from greenlight.yaml",
	)
	.option("--debug", "enable verbose debug output", false)
	.option(
		"--trace",
		"log timestamped browser events for performance analysis",
		false,
	)
	.option("--discover", "force full discovery run, ignore cached plans", false)
	.option(
		"--on-drift <mode>",
		'behavior on plan drift: "fail" or "rerun" (default: fail)',
	)
	.option(
		"--plan-status",
		"show cached plan status for all test cases and exit",
		false,
	)
	.action(
		async (
			suitesArg: string[],
			opts: {
				test?: string
				baseUrl?: string
				reporter?: string
				output?: string
				headed?: boolean
				parallel?: string
				timeout?: string
				model?: string
				llmBaseUrl?: string
				deployment?: string
				debug: boolean
				trace: boolean
				discover: boolean
				onDrift?: string
				planStatus: boolean
			},
		) => {
			// Load project config (greenlight.yaml)
			const projectConfig = await loadProjectConfig(opts.deployment)

			// Resolve suite files: CLI args > greenlight.yaml > error
			let suiteFiles: string[]
			if (suitesArg.length > 0) {
				suiteFiles = suitesArg.map((s) => resolve(s))
			} else if (projectConfig?.suites) {
				suiteFiles = projectConfig.suites.map((s) => resolve(s))
			} else {
				console.error(
					"No suite files specified. Provide them as arguments or in greenlight.yaml.",
				)
				process.exit(1)
			}

			// Build config: CLI flags > greenlight.yaml > built-in defaults
			const config: RunConfig = {
				suiteFiles,
				testFilter: opts.test,
				baseUrl: opts.baseUrl ?? projectConfig?.base_url,
				reporter: parseReporter(
					opts.reporter ?? projectConfig?.reporter ?? DEFAULTS.reporter,
				),
				outputPath: opts.output ? resolve(opts.output) : undefined,
				headed: opts.headed ?? projectConfig?.headed ?? DEFAULTS.headed,
				parallel: opts.parallel
					? parseInt(opts.parallel, 10)
					: (projectConfig?.parallel ?? DEFAULTS.parallel),
				timeout: opts.timeout
					? parseInt(opts.timeout, 10)
					: (projectConfig?.timeout ?? DEFAULTS.timeout),
				viewport: projectConfig?.viewport
					? { ...projectConfig.viewport }
					: { ...DEFAULTS.viewport },
				model: opts.model ?? projectConfig?.model ?? DEFAULTS.model,
				llmBaseUrl:
					opts.llmBaseUrl ??
					projectConfig?.llm_base_url ??
					DEFAULTS.llmBaseUrl,
				discover: opts.discover,
				onDrift: parseOnDrift(opts.onDrift ?? DEFAULTS.onDrift),
			}

			// Initialize global runtime state (debug, trace)
			initGlobals({
				debug: opts.debug ?? false,
				trace: createTraceLogger(opts.trace),
			})

			// Resolve glob patterns in suite file paths
			const resolvedFiles = await resolveGlobs(config.suiteFiles)

			if (resolvedFiles.length === 0) {
				console.error("No suite files found matching:", config.suiteFiles)
				process.exit(1)
			}

			const cwd = process.cwd()

			// --plan-status: show cache status and exit
			if (opts.planStatus) {
				await showPlanStatus(resolvedFiles, cwd, config)
				return
			}

			// Load and run each suite
			for (const file of resolvedFiles) {
				// Load suite
				let suite
				try {
					suite = await loadSuite(file)
				} catch (err) {
					console.error(`\nFailed to load suite: ${file}`)
					if (err instanceof Error) console.error(err.message)
					process.exit(1)
				}

				// Resolve base URL: CLI flag > deployment/config > suite
				const baseUrl = config.baseUrl ?? suite.base_url
				if (!baseUrl) {
					console.error(
						`No base_url for suite "${suite.suite}". Set it in the suite YAML, greenlight.yaml, or pass --base-url.`,
					)
					process.exit(1)
				}
				suite.base_url = baseUrl

				// Apply suite-level model override
				const effectiveModel = suite.model ?? config.model
				const suiteSlug = slugify(suite.suite)

				console.log(`\nSuite: ${suite.suite}`)
				console.log(`URL:   ${baseUrl}`)
				console.log(`Model: ${effectiveModel}`)

				// Load hash index for plan caching
				const hashIndex = await loadHashIndex(cwd)

				// LLM client — created lazily, only when a test needs discovery
				let llm: LLMClient | undefined

				function getOrCreateLLM(): LLMClient {
					if (!llm) {
						const llmConfig = resolveLLMConfig({
							...config,
							model: effectiveModel,
						})
						llm = createLLMClient(llmConfig)
					}
					return llm
				}

				// Launch browser
				const browserOpts = toBrowserOptions(config)
				let browser
				try {
					browser = await launchBrowser(browserOpts)
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err)
					console.error(`\nFailed to launch browser: ${msg}`)
					process.exit(1)
				}

				let hashIndexDirty = false

				try {
					// Filter tests
					const tests = config.testFilter
						? suite.tests.filter((t) => t.name === config.testFilter)
						: suite.tests

					for (const test of tests) {
						const testSlug = slugify(test.name)
						const testHash = computeTestHash(test)
						const hashKey = `${suiteSlug}/${testSlug}`
						const cachedHash = hashIndex[hashKey]

						// Determine execution mode
						let useCachedPlan = false
						let cachedPlan = null

						if (!config.discover && cachedHash === testHash) {
							cachedPlan = await loadPlan(cwd, suiteSlug, testSlug)
							if (cachedPlan) {
								useCachedPlan = true
							}
						}

						const modeLabel = useCachedPlan
							? "\x1b[36mcached\x1b[0m"
							: "\x1b[33mdiscovery\x1b[0m"
						console.log(`\n  Test: ${test.name} [${modeLabel}]`)

						if (
							!config.discover &&
							cachedHash &&
							cachedHash !== testHash
						) {
							console.log(
								`    \x1b[33mPlan stale, re-discovering\x1b[0m`,
							)
						}

						// Fresh context per test case
						const context = await createContext(browser, browserOpts)
						const page = await createPage(context)
						const { drain } = attachConsoleCollector(page)
						const { waitForNetworkIdle } = attachNetworkTracker(page)
						globals.trace.attachToPage(page)

						try {
							globals.trace.log("goto", suite.base_url)
							await page.goto(suite.base_url)
						} catch (err) {
							const msg =
								err instanceof Error ? err.message : String(err)
							console.error(
								`\n  \x1b[31m\u2717\x1b[0m Failed to navigate to ${suite.base_url}: ${msg}`,
							)
							globals.trace.detachFromPage(page)
							await context.close()
							continue
						}

						let result: TestCaseResult

						if (useCachedPlan && cachedPlan) {
							// Fast run — replay cached plan
							result = await runCachedPlan(
								page,
								cachedPlan,
								test.name,
								{ waitForNetworkIdle },
							)

							// Handle plan drift
							if (result.drifted && config.onDrift === "rerun") {
								console.log(
									`    \x1b[33mPlan drift detected, re-running with LLM\x1b[0m`,
								)
								// Close and re-create context for fresh state
								globals.trace.detachFromPage(page)
								await context.close()

								const ctx2 = await createContext(
									browser,
									browserOpts,
								)
								const page2 = await createPage(ctx2)
								const { drain: drain2 } =
									attachConsoleCollector(page2)
								const { waitForNetworkIdle: waitForNetworkIdle2 } =
									attachNetworkTracker(page2)
								globals.trace.attachToPage(page2)
								await page2.goto(suite.base_url)

								const recorder = createPlanRecorder(
									suiteSlug,
									testSlug,
									testHash,
									effectiveModel,
								)
								result = await runTestCase(
									page2,
									test,
									getOrCreateLLM(),
									{
										timeout: config.timeout,
										consoleDrain: drain2,
										recorder,
										waitForNetworkIdle: waitForNetworkIdle2,
									},
								)
								result.mode = "discovery"

								if (result.status === "passed") {
									const plan = recorder.finalize()
									await savePlan(cwd, plan)
									hashIndex[hashKey] = testHash
									hashIndexDirty = true
									await ensureGitignore(cwd)
									console.log(
										`    \x1b[32mCached plan updated\x1b[0m`,
									)
								}

								globals.trace.detachFromPage(page2)
								await ctx2.close()
								printStepResults(result)
								printTestSummary(result)
								if (config.headed) {
									await new Promise((r) =>
										setTimeout(r, 2000),
									)
								}
								continue
							}
						} else {
							// Discovery run — full LLM loop with recorder
							const recorder = createPlanRecorder(
								suiteSlug,
								testSlug,
								testHash,
								effectiveModel,
							)

							result = await runTestCase(
								page,
								test,
								getOrCreateLLM(),
								{
									timeout: config.timeout,
									consoleDrain: drain,
									recorder,
									waitForNetworkIdle,
								},
							)
							result.mode = "discovery"

							// Save plan only if the test passed
							if (result.status === "passed") {
								const plan = recorder.finalize()
								await savePlan(cwd, plan)
								hashIndex[hashKey] = testHash
								hashIndexDirty = true
								await ensureGitignore(cwd)
								console.log(
									`    \x1b[32mCached plan generated for: ${test.name}\x1b[0m`,
								)
							}
						}

						printStepResults(result)
						printTestSummary(result)

						if (config.headed) {
							await new Promise((r) => setTimeout(r, 2000))
						}

						globals.trace.detachFromPage(page)
						await context.close()
					}
				} finally {
					if (hashIndexDirty) {
						await saveHashIndex(cwd, hashIndex)
					}
					await closeBrowser(browser)
				}
			}
		},
	)

/** Print step-by-step results for a test case. */
function printStepResults(result: TestCaseResult): void {
	for (const stepResult of result.steps) {
		const icon =
			stepResult.status === "passed"
				? "\x1b[32m\u2713\x1b[0m"
				: "\x1b[31m\u2717\x1b[0m"
		const dur = `${String(Math.round(stepResult.duration))}ms`
		const t = stepResult.timing
		const phases = t
			? ` \x1b[90m[capture:${String(Math.round(t.capture))} llm:${String(Math.round(t.llm))} exec:${String(Math.round(t.execute))} post:${String(Math.round(t.postCapture))}ms]\x1b[0m`
			: ""
		console.log(`    ${icon} ${stepResult.step} (${dur})${phases}`)
		if (stepResult.error) {
			console.log(`      \x1b[31m${stepResult.error}\x1b[0m`)
		}
		if (globals.debug && stepResult.action) {
			console.log(`      Action: ${JSON.stringify(stepResult.action)}`)
		}
	}
}

/** Print pass/fail summary for a test case. */
function printTestSummary(result: TestCaseResult): void {
	const modeTag =
		result.mode === "cached" ? " \x1b[36m[cached]\x1b[0m" : ""
	const testIcon =
		result.status === "passed"
			? "\x1b[32mPASSED\x1b[0m"
			: "\x1b[31mFAILED\x1b[0m"
	console.log(
		`\n  ${testIcon}${modeTag} (${String(Math.round(result.duration))}ms)`,
	)
}

/** Show plan status for all test cases across all suites. */
async function showPlanStatus(
	suiteFiles: string[],
	cwd: string,
	config: RunConfig,
): Promise<void> {
	const hashIndex = await loadHashIndex(cwd)

	for (const file of suiteFiles) {
		let suite
		try {
			suite = await loadSuite(file)
		} catch (err) {
			console.error(`Failed to load suite: ${file}`)
			if (err instanceof Error) console.error(err.message)
			continue
		}

		const suiteSlug = slugify(suite.suite)
		const tests = config.testFilter
			? suite.tests.filter((t) => t.name === config.testFilter)
			: suite.tests

		console.log(`\nSuite: ${suite.suite}`)

		for (const test of tests) {
			const testSlug = slugify(test.name)
			const testHash = computeTestHash(test)
			const hashKey = `${suiteSlug}/${testSlug}`
			const cachedHash = hashIndex[hashKey]

			if (!cachedHash) {
				console.log(
					`  ${hashKey}: \x1b[33mno cached plan\x1b[0m`,
				)
			} else if (cachedHash !== testHash) {
				console.log(
					`  ${hashKey}: \x1b[33mstale\x1b[0m (definition changed)`,
				)
			} else {
				const plan = await loadPlan(cwd, suiteSlug, testSlug)
				if (plan) {
					console.log(
						`  ${hashKey}: \x1b[32mcached\x1b[0m (hash: ${cachedHash.slice(0, 8)}, generated: ${plan.generatedAt.split("T")[0]})`,
					)
				} else {
					console.log(
						`  ${hashKey}: \x1b[33mhash exists but plan file missing\x1b[0m`,
					)
				}
			}
		}
	}
}

function parseReporter(value: string): RunConfig["reporter"] {
	if (value === "cli" || value === "json" || value === "html") {
		return value
	}
	console.error(`Invalid reporter "${value}". Must be cli, json, or html.`)
	process.exit(1)
}

function parseOnDrift(value: string): RunConfig["onDrift"] {
	if (value === "fail" || value === "rerun") {
		return value
	}
	console.error(
		`Invalid --on-drift value "${value}". Must be "fail" or "rerun".`,
	)
	process.exit(1)
}

/** Expand glob patterns into concrete file paths. */
async function resolveGlobs(patterns: string[]): Promise<string[]> {
	const files: string[] = []
	for (const pattern of patterns) {
		// If pattern has no glob chars, treat as literal path
		if (!pattern.includes("*")) {
			files.push(pattern)
			continue
		}
		const matches = await new Promise<string[]>((res, rej) => {
			glob(pattern, (err, result) => {
				if (err) rej(err)
				else res(result)
			})
		})
		files.push(...matches)
	}
	return files
}

program.parse()
