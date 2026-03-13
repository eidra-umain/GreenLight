#!/usr/bin/env node

import "dotenv/config"
import { Command } from "commander"
import { DEFAULTS, type RunConfig } from "../types.js"
import { loadSuite } from "../parser/loader.js"
import {
	launchBrowser,
	createContext,
	createPage,
	closeBrowser,
	toBrowserOptions,
} from "../browser/browser.js"
import {
	capturePageState,
	attachConsoleCollector,
	resetRefCounter,
	formatA11yTree,
} from "../pilot/state.js"
import { resolveLLMConfig, createLLMClient } from "../pilot/llm.js"
import { executeAction } from "../pilot/executor.js"
import { resolve } from "node:path"
import { glob } from "node:fs"
import { writeFile } from "node:fs/promises"

const program = new Command()

program
	.name("greenlight")
	.description("AI-driven E2E testing tool")
	.version("0.1.0")

program
	.command("run")
	.description("Run test suites against a staging environment")
	.argument("[suites...]", "paths to suite YAML files", ["./tests/**/*.yaml"])
	.option("-t, --test <name>", "run only the test case matching this name")
	.option("--base-url <url>", "override the suite base URL")
	.option(
		"-r, --reporter <format>",
		"output format: cli, json, or html",
		DEFAULTS.reporter,
	)
	.option("-o, --output <path>", "write report to file instead of stdout")
	.option("--headed", "run browser in visible (headed) mode", DEFAULTS.headed)
	.option(
		"-p, --parallel <n>",
		"number of test cases to run concurrently",
		String(DEFAULTS.parallel),
	)
	.option(
		"--timeout <ms>",
		"per-step timeout in milliseconds",
		String(DEFAULTS.timeout),
	)
	.option(
		"--model <model>",
		"LLM model identifier (e.g. anthropic/claude-sonnet-4)",
		DEFAULTS.model,
	)
	.option(
		"--llm-base-url <url>",
		"base URL for the OpenAI-compatible LLM API",
		DEFAULTS.llmBaseUrl,
	)
	.option("--debug", "enable verbose debug output", false)
	.action(
		async (
			suites: string[],
			opts: {
				test?: string
				baseUrl?: string
				reporter: string
				output?: string
				headed: boolean
				parallel: string
				timeout: string
				model: string
				llmBaseUrl: string
				debug: boolean
			},
		) => {
			const config: RunConfig = {
				suiteFiles: suites.map((s) => resolve(s)),
				testFilter: opts.test,
				baseUrl: opts.baseUrl,
				reporter: parseReporter(opts.reporter),
				outputPath: opts.output ? resolve(opts.output) : undefined,
				headed: opts.headed,
				parallel: parseInt(opts.parallel, 10),
				timeout: parseInt(opts.timeout, 10),
				viewport: { ...DEFAULTS.viewport },
				model: opts.model,
				llmBaseUrl: opts.llmBaseUrl,
			}

			// Resolve glob patterns in suite file paths
			const resolvedFiles = await resolveGlobs(config.suiteFiles)

			if (resolvedFiles.length === 0) {
				console.error("No suite files found matching:", config.suiteFiles)
				process.exit(1)
			}

			// Load and run each suite
			for (const file of resolvedFiles) {
				try {
					const suite = await loadSuite(file)

					// Apply CLI overrides
					if (config.baseUrl) {
						suite.base_url = config.baseUrl
					}

					// Apply suite-level model override
					const effectiveModel = suite.model ?? config.model

					console.log(`\nSuite: ${suite.suite}`)
					console.log(`URL:   ${suite.base_url}`)

					// Launch browser and navigate
					const browserOpts = toBrowserOptions(config)
					const browser = await launchBrowser(browserOpts)

					try {
						const context = await createContext(browser, browserOpts)
						const page = await createPage(context)
						const { drain } = attachConsoleCollector(page)

						await page.goto(suite.base_url)
						resetRefCounter()

						const state = await capturePageState(page, drain)

						if (opts.debug) {
							console.log(`\nAccessibility tree (${suite.base_url}):\n`)
							console.log(formatA11yTree(state.a11yTree))

							const screenshotPath = resolve("screenshot.png")
							await writeFile(
								screenshotPath,
								Buffer.from(state.screenshot, "base64"),
							)
							console.log(`\nScreenshot saved: ${screenshotPath}`)
							console.log(`Page title: ${state.title}`)
							console.log(
								`Console logs: ${String(state.consoleLogs.length)} entries`,
							)
						}

						// Print test cases
						for (const test of suite.tests) {
							if (config.testFilter && test.name !== config.testFilter) {
								continue
							}
							console.log(`\n  Test: ${test.name}`)
							for (const step of test.steps) {
								console.log(`    - ${step}`)
							}
						}

						// Step 5 test harness: resolve + execute first step
						const firstTest = config.testFilter
							? suite.tests.find((t) => t.name === config.testFilter)
							: suite.tests[0]

						if (firstTest && firstTest.steps.length > 0) {
							const step = firstTest.steps[0]
							console.log(
								`\n  Sending step to LLM (${effectiveModel}): "${step}"`,
							)

							try {
								const llmConfig = resolveLLMConfig({
									...config,
									model: effectiveModel,
								})
								const llm = createLLMClient(llmConfig)
								const action = await llm.resolveStep(step, state)
								console.log("  LLM action:", JSON.stringify(action))

								// Execute the action
								console.log("  Executing action...")
								const result = await executeAction(page, action, state.a11yTree)

								if (result.success) {
									console.log(
										`  Action succeeded (${Math.round(result.duration)}ms)`,
									)
								} else {
									console.error(
										`  Action failed: ${result.error ?? "unknown error"}`,
									)
								}

								// Capture post-action state
								resetRefCounter()
								const postState = await capturePageState(page, drain)

								if (opts.debug) {
									console.log(`\n  Post-action a11y tree:\n`)
									console.log(formatA11yTree(postState.a11yTree))
								}

								console.log(`  Post-action URL: ${postState.url}`)
							} catch (err) {
								if (err instanceof Error) {
									console.error(`  LLM error: ${err.message}`)
								}
							}
						}

						if (config.headed) {
							await new Promise((r) => setTimeout(r, 2000))
						}

						await context.close()
					} finally {
						await closeBrowser(browser)
					}
				} catch (err) {
					console.error(`\nFailed to load suite: ${file}`)
					if (err instanceof Error) {
						console.error(err.message)
					}
					process.exit(1)
				}
			}

			console.log("\nNo runner implemented yet. Exiting.")
		},
	)

function parseReporter(value: string): RunConfig["reporter"] {
	if (value === "cli" || value === "json" || value === "html") {
		return value
	}
	console.error(`Invalid reporter "${value}". Must be cli, json, or html.`)
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
