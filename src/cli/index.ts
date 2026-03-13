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
import { attachConsoleCollector } from "../pilot/state.js"
import { resolveLLMConfig, createLLMClient } from "../pilot/llm.js"
import { runTestCase } from "../pilot/pilot.js"
import { resolve } from "node:path"
import { glob } from "node:fs"

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
					opts.llmBaseUrl ?? projectConfig?.llm_base_url ?? DEFAULTS.llmBaseUrl,
			}

			// Resolve glob patterns in suite file paths
			const resolvedFiles = await resolveGlobs(config.suiteFiles)

			if (resolvedFiles.length === 0) {
				console.error("No suite files found matching:", config.suiteFiles)
				process.exit(1)
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

				console.log(`\nSuite: ${suite.suite}`)
				console.log(`URL:   ${baseUrl}`)
				console.log(`Model: ${effectiveModel}`)

				// Create LLM client
				let llm
				try {
					const llmConfig = resolveLLMConfig({
						...config,
						model: effectiveModel,
					})
					llm = createLLMClient(llmConfig)
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err)
					console.error(`\nLLM configuration error: ${msg}`)
					process.exit(1)
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

				try {
					// Filter tests
					const tests = config.testFilter
						? suite.tests.filter((t) => t.name === config.testFilter)
						: suite.tests

					for (const test of tests) {
						console.log(`\n  Test: ${test.name}`)

						// Fresh context per test case
						const context = await createContext(browser, browserOpts)
						const page = await createPage(context)
						const { drain } = attachConsoleCollector(page)

						try {
							await page.goto(suite.base_url)
						} catch (err) {
							const msg = err instanceof Error ? err.message : String(err)
							console.error(
								`\n  \x1b[31m\u2717\x1b[0m Failed to navigate to ${suite.base_url}: ${msg}`,
							)
							await context.close()
							continue
						}

						const result = await runTestCase(page, test, llm, {
							timeout: config.timeout,
							consoleDrain: drain,
							debug: opts.debug,
						})

						// Print step-by-step results
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
							if (opts.debug && stepResult.action) {
								console.log(
									`      Action: ${JSON.stringify(stepResult.action)}`,
								)
							}
						}

						// Summary for this test
						const testIcon =
							result.status === "passed"
								? "\x1b[32mPASSED\x1b[0m"
								: "\x1b[31mFAILED\x1b[0m"
						console.log(
							`\n  ${testIcon} (${String(Math.round(result.duration))}ms)`,
						)

						if (config.headed) {
							await new Promise((r) => setTimeout(r, 2000))
						}

						await context.close()
					}
				} finally {
					await closeBrowser(browser)
				}
			}
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
