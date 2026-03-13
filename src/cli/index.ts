#!/usr/bin/env node

import { Command } from "commander"
import { DEFAULTS, type RunConfig } from "../types.js"
import { resolve } from "node:path"

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
		(
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

			console.log("GreenLight — resolved config:\n")
			console.log(JSON.stringify(config, null, 2))
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

program.parse()
