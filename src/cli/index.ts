#!/usr/bin/env node

import "dotenv/config"
import { Command } from "commander"
import { DEFAULTS, type RunConfig, type Provider } from "../types.js"
import { loadProjectConfig } from "../config.js"
import { createTraceLogger } from "../pilot/trace.js"
import { resolve } from "node:path"
import { glob } from "node:fs"
import { initGlobals } from "../globals.js"
import { runCommand, showPlanStatus } from "./run.js"

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
	.option("--llm-base-url <url>", "base URL for the LLM API (override)")
	.option(
		"--provider <name>",
		"LLM provider: openrouter, openai, gemini, or claude",
	)
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
	.option("--pilot", "force pilot (LLM) run, ignore cached plans", false)
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
				provider?: string
				deployment?: string
				debug: boolean
				trace: boolean
				pilot: boolean
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
				provider: parseProvider(
					opts.provider ??
						projectConfig?.provider ??
						DEFAULTS.provider,
				),
				llmBaseUrl:
					opts.llmBaseUrl ?? projectConfig?.llm_base_url,
				pilot: opts.pilot,
				onDrift: parseOnDrift(opts.onDrift ?? DEFAULTS.onDrift),
			}

			// Initialize global runtime state (debug, trace)
			initGlobals({
				debug: opts.debug,
				trace: createTraceLogger(opts.trace),
			})

			// Resolve glob patterns in suite file paths
			const resolvedFiles = await resolveGlobs(config.suiteFiles)

			if (resolvedFiles.length === 0) {
				console.error("No suite files found matching:", config.suiteFiles)
				process.exit(1)
			}

			// --plan-status: show cache status and exit
			if (opts.planStatus) {
				await showPlanStatus(resolvedFiles, process.cwd(), config)
				return
			}

			await runCommand(config, resolvedFiles)
		},
	)

function parseProvider(value: string): Provider {
	if (
		value === "openrouter" ||
		value === "openai" ||
		value === "gemini" ||
		value === "claude"
	) {
		return value
	}
	console.error(
		`Invalid provider "${value}". Must be openrouter, openai, gemini, or claude.`,
	)
	process.exit(1)
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
