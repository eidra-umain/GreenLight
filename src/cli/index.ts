#!/usr/bin/env node

import { Command } from "commander"
import { DEFAULTS, type RunConfig } from "../types.js"
import { loadSuite } from "../parser/loader.js"
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
			}

			// Resolve glob patterns in suite file paths
			const resolvedFiles = await resolveGlobs(config.suiteFiles)

			if (resolvedFiles.length === 0) {
				console.error("No suite files found matching:", config.suiteFiles)
				process.exit(1)
			}

			// Load and display each suite
			for (const file of resolvedFiles) {
				try {
					const suite = await loadSuite(file)

					// Apply CLI overrides
					if (config.baseUrl) {
						suite.base_url = config.baseUrl
					}

					console.log(`\nSuite: ${suite.suite}`)
					console.log(`URL:   ${suite.base_url}`)
					if (suite.viewport) {
						console.log(
							`Viewport: ${String(suite.viewport.width)}x${String(suite.viewport.height)}`,
						)
					}

					for (const test of suite.tests) {
						// Apply test name filter
						if (config.testFilter && test.name !== config.testFilter) {
							continue
						}
						console.log(`\n  Test: ${test.name}`)
						for (const step of test.steps) {
							console.log(`    - ${step}`)
						}
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
