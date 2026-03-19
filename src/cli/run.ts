import { loadSuite } from "../parser/loader.js"
import {
	launchBrowser,
	launchPersistentContextWithZoom,
	createContext,
	createPage,
	closeBrowser,
	toBrowserOptions,
} from "../browser/browser.js"
import {
	attachConsoleCollector,
	attachNetworkTracker,
} from "../pilot/network.js"
import {
	resolveLLMConfig,
	createLLMClient,
	type LLMClient,
} from "../pilot/llm.js"
import { runTestCase } from "../pilot/pilot.js"
import { computeTestHash, slugify } from "../planner/hasher.js"
import {
	loadHashIndex,
	saveHashIndex,
	loadPlan,
	savePlan,
	loadPartialPlan,
	savePartialPlan,
	deletePartialPlan,
	ensureGitignore,
} from "../planner/plan-store.js"
import { createPlanRecorder } from "../planner/plan-generator.js"
import { runCachedPlan } from "../planner/plan-runner.js"
import type { StepResult, TestCaseResult } from "../reporter/types.js"
import type { RunConfig } from "../types.js"
import { resolveModelConfig } from "../types.js"
import { globals } from "../globals.js"
import { LLMApiError } from "../pilot/providers/index.js"

/** Print a single step result as it completes. */
function printStepResult(stepResult: StepResult): void {
	const icon =
		stepResult.status === "passed"
			? "\x1b[32m\u2713\x1b[0m"
			: "\x1b[31m\u2717\x1b[0m"
	const dur = `${String(Math.round(stepResult.duration))}ms`
	const t = stepResult.timing
	const phases = t
		? ` \x1b[90m[capture:${String(Math.round(t.capture))} llm:${String(Math.round(t.llm))} exec:${String(Math.round(t.execute))} post:${String(Math.round(t.postCapture))}ms]\x1b[0m`
		: ""
	// Strip internal "||" separator from datepick step names
	const stepName = stepResult.step.includes("||") ? stepResult.step.split("||")[0] : stepResult.step
	const condTag = stepResult.conditionResult
		? ` \x1b[90m[${stepResult.conditionResult.branch}]\x1b[0m`
		: ""
	console.log(`    ${icon} ${stepName} (${dur})${phases}${condTag}`)
	if (stepResult.error) {
		console.log(`      \x1b[31m${stepResult.error}\x1b[0m`)
	}
	if (globals.debug && stepResult.action) {
		console.log(`      Action: ${JSON.stringify(stepResult.action)}`)
	}
}

/** Print pass/fail summary for a test case. */
function printTestSummary(result: TestCaseResult): void {
	const modeTag = result.mode === "cached" ? " \x1b[36m[cached]\x1b[0m" : ""
	const testIcon =
		result.status === "passed"
			? "\x1b[32mPASSED\x1b[0m"
			: "\x1b[31mFAILED\x1b[0m"
	console.log(
		`\n  ${testIcon}${modeTag} (${String(Math.round(result.duration))}ms)`,
	)
}

/** Show plan status for all test cases across all suites. */
export async function showPlanStatus(
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
				console.log(`  ${hashKey}: \x1b[33mno cached plan\x1b[0m`)
			} else if (cachedHash !== testHash) {
				console.log(`  ${hashKey}: \x1b[33mstale\x1b[0m (definition changed)`)
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

/**
 * Run all test suites according to the resolved configuration.
 * This is the main test execution entry point called by the CLI.
 */
export async function runCommand(
	config: RunConfig,
	resolvedFiles: string[],
): Promise<void> {
	const cwd = process.cwd()

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

		// Resolve base URL: CLI flag > deployment config
		const baseUrl = config.baseUrl
		if (!baseUrl) {
			console.error(
				`No base_url for suite "${suite.suite}". Set it in greenlight.yaml or pass --base-url.`,
			)
			process.exit(1)
		}

		// Apply suite-level model override
		const effectiveModel = suite.model ?? config.model
		const suiteSlug = slugify(suite.suite)
		const resolved = resolveModelConfig(effectiveModel)

		console.log(`\nSuite: ${suite.suite}`)
		console.log(`URL:   ${baseUrl}`)
		console.log(`Provider: ${config.provider}`)
		if (resolved.planner === resolved.pilot) {
			console.log(`Model: ${resolved.planner}`)
		} else {
			console.log(`Model: planner=${resolved.planner}, pilot=${resolved.pilot}`)
		}

		// Load hash index for plan caching
		const hashIndex = await loadHashIndex(cwd)

		// LLM client — created lazily, only when a test needs pilot mode
		let llm: LLMClient | undefined

		function getOrCreateLLM(): LLMClient {
			if (!llm) {
				try {
					const llmConfig = resolveLLMConfig({
						...config,
						model: effectiveModel,
					})
					llm = createLLMClient(llmConfig)
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err)
					console.error(`\n  \x1b[31m${msg}\x1b[0m`)
					console.error(`  Set it in a .env file or export it in your shell:`)
					console.error(`  $ export LLM_API_KEY=sk-...`)
					process.exit(1)
				}
			}
			return llm
		}

		// Launch browser — in headed mode use a persistent context with the
		// zoom extension for real 50% browser zoom. In headless mode use the
		// normal browser + context flow.
		// Suite-level viewport overrides the project/default viewport.
		const effectiveViewport = suite.viewport ?? config.viewport
		const browserOpts = toBrowserOptions({
			...config,
			viewport: effectiveViewport,
		})
		let browser: Awaited<ReturnType<typeof launchBrowser>> | null = null
		let persistentContext:
			| Awaited<ReturnType<typeof launchPersistentContextWithZoom>>["context"]
			| null = null
		try {
			if (browserOpts.headed) {
				const result = await launchPersistentContextWithZoom(browserOpts)
				persistentContext = result.context
			} else {
				browser = await launchBrowser(browserOpts)
			}
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
				try {
					const testSlug = slugify(test.name)
					const testHash = computeTestHash(test)
					const hashKey = `${suiteSlug}/${testSlug}`
					const cachedHash = hashIndex[hashKey]

					// Determine execution mode
					let useCachedPlan = false
					let cachedPlan = null

					if (!config.pilot && cachedHash === testHash) {
						cachedPlan = await loadPlan(cwd, suiteSlug, testSlug)
						if (cachedPlan) {
							useCachedPlan = true
						}
					}

					const modeLabel = useCachedPlan
						? "\x1b[36mcached\x1b[0m"
						: "\x1b[33mpilot\x1b[0m"
					console.log(`\n  Test: ${test.name} [${modeLabel}]`)

					if (!config.pilot && cachedHash && cachedHash !== testHash) {
						console.log(`    \x1b[33mPlan stale, running pilot\x1b[0m`)
					}

					// Fresh context per test case (reuse persistent context in headed mode)
					// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
					const context =
						persistentContext ?? (await createContext(browser!, browserOpts))
					const page = await createPage(context, { headed: browserOpts.headed })
					const { drain } = attachConsoleCollector(page)
					const { waitForNetworkIdle } = attachNetworkTracker(page)
					globals.trace.attachToPage(page)

					try {
						globals.trace.log("goto", baseUrl)
						await page.goto(baseUrl)
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err)
						console.error(
							`\n  \x1b[31m\u2717\x1b[0m Failed to navigate to ${baseUrl}: ${msg}`,
						)
						globals.trace.detachFromPage(page)
						if (persistentContext) {
							// Persistent context is shared — close pages only
							for (const p of context.pages()) await p.close().catch(() => {})
						} else {
							await context.close()
						}
						continue
					}

					let result: TestCaseResult

					if (useCachedPlan && cachedPlan) {
						// Fast run — replay cached plan
						result = await runCachedPlan(page, cachedPlan, test.name, {
							waitForNetworkIdle,
							onStepComplete: printStepResult,
							consoleDrain: drain,
						})

						// Handle plan drift
						if (result.drifted && config.onDrift === "rerun") {
							console.log(
								`    \x1b[33mPlan drift detected, re-running with LLM\x1b[0m`,
							)
							// Close and re-create context for fresh state
							globals.trace.detachFromPage(page)
							if (persistentContext) {
								// Persistent context is shared — close pages only
								for (const p of context.pages())
									await p.close().catch(() => {
										/* ignore */
									})
							} else {
								await context.close()
							}

							const ctx2 =
								persistentContext ??
								(await createContext(
									// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
									browser!,
									browserOpts,
								))
							const page2 = await createPage(ctx2, {
								headed: browserOpts.headed,
							})
							const { drain: drain2 } = attachConsoleCollector(page2)
							const { waitForNetworkIdle: waitForNetworkIdle2 } =
								attachNetworkTracker(page2)
							globals.trace.attachToPage(page2)
							await page2.goto(baseUrl)

							const modelLabel =
								typeof effectiveModel === "string"
									? effectiveModel
									: `${effectiveModel.planner}/${effectiveModel.pilot}`
							const recorder = createPlanRecorder(
								suiteSlug,
								testSlug,
								testHash,
								modelLabel,
							)
							result = await runTestCase(page2, test, getOrCreateLLM(), {
								timeout: config.timeout,
								consoleDrain: drain2,
								recorder,
								waitForNetworkIdle: waitForNetworkIdle2,
								onStepComplete: printStepResult,
							})
							result.mode = "pilot"

							if (result.status === "passed") {
								const plan = recorder.finalize()
								await savePlan(cwd, plan)
								hashIndex[hashKey] = testHash
								hashIndexDirty = true
								await ensureGitignore(cwd)
								console.log(`    \x1b[32mCached plan updated\x1b[0m`)
							}

							globals.trace.detachFromPage(page2)
							await ctx2.close()
							printTestSummary(result)
							if (config.headed) {
								await new Promise((r) => setTimeout(r, 2000))
							}
							continue
						}
					} else {
						// Pilot run — check for partial plan to resume from
						const partialPlan = config.pilot
							? await loadPartialPlan(cwd, suiteSlug, testSlug)
							: null
						const hasPartial = partialPlan && partialPlan.sourceHash === testHash && partialPlan.steps.length > 0

						let resumeSteps = test.steps
						if (hasPartial && partialPlan.remainingSteps) {
							// Replay cached steps from previous partial run
							console.log(`    \x1b[36mResuming from partial plan (${String(partialPlan.steps.length)} cached steps)\x1b[0m`)
							const partialResult = await runCachedPlan(
								page,
								partialPlan,
								test.name,
								{
									waitForNetworkIdle,
									onStepComplete: printStepResult,
									consoleDrain: drain,
								},
							)
							if (partialResult.drifted || partialResult.status === "failed") {
								// Partial plan drifted — fall back to full pilot run
								console.log(`    \x1b[33mPartial plan drifted, running full pilot\x1b[0m`)
								await deletePartialPlan(cwd, suiteSlug, testSlug)
								// Re-create page for clean state
								globals.trace.detachFromPage(page)
								if (persistentContext) {
									for (const p of context.pages()) await p.close().catch(() => {})
								} else {
									await context.close()
								}
								const ctx3 = persistentContext ?? (await createContext(browser!, browserOpts))
								const page3 = await createPage(ctx3, { headed: browserOpts.headed })
								const { drain: drain3 } = attachConsoleCollector(page3)
								const { waitForNetworkIdle: wni3 } = attachNetworkTracker(page3)
								globals.trace.attachToPage(page3)
								await page3.goto(baseUrl)
								// Fall through to normal pilot below with full steps
								// (can't reassign page/drain/waitForNetworkIdle, so recurse would be complex —
								// for now just re-run the whole test)
								resumeSteps = test.steps

								const modelLabel3 = typeof effectiveModel === "string" ? effectiveModel : `${effectiveModel.planner}/${effectiveModel.pilot}`
								const recorder3 = createPlanRecorder(suiteSlug, testSlug, testHash, modelLabel3)
								result = await runTestCase(page3, { name: test.name, steps: resumeSteps }, getOrCreateLLM(), {
									timeout: config.timeout,
									consoleDrain: drain3,
									recorder: recorder3,
									waitForNetworkIdle: wni3,
									onStepComplete: printStepResult,
								})
								result.mode = "pilot"
								if (result.status === "passed") {
									const plan = recorder3.finalize()
									await savePlan(cwd, plan)
									hashIndex[hashKey] = testHash
									hashIndexDirty = true
									await deletePartialPlan(cwd, suiteSlug, testSlug)
									await ensureGitignore(cwd)
									console.log(`    \x1b[32mCached plan generated for: ${test.name}\x1b[0m`)
								} else {
									const completed3 = result.completedInputSteps ?? 0
									const remaining3 = resumeSteps.slice(completed3)
									if (remaining3.length > 0 && completed3 > 0) {
										const partial = recorder3.finalizePartial(remaining3)
										await savePartialPlan(cwd, partial)
										await ensureGitignore(cwd)
									}
								}
								globals.trace.detachFromPage(page3)
								if (!persistentContext) await ctx3.close()
								printTestSummary(result)
								if (config.headed) await new Promise((r) => setTimeout(r, 2000))
								continue
							}
							// Partial replay succeeded — continue with remaining steps
							resumeSteps = partialPlan.remainingSteps
							console.log(`    \x1b[33mSwitching to pilot for ${String(resumeSteps.length)} remaining steps\x1b[0m`)
						}

						const modelLabel =
							typeof effectiveModel === "string"
								? effectiveModel
								: `${effectiveModel.planner}/${effectiveModel.pilot}`
						const recorder = createPlanRecorder(
							suiteSlug,
							testSlug,
							testHash,
							modelLabel,
						)

						const pilotResult = await runTestCase(page, { name: test.name, steps: resumeSteps }, getOrCreateLLM(), {
							timeout: config.timeout,
							consoleDrain: drain,
							recorder,
							waitForNetworkIdle,
							onStepComplete: printStepResult,
						})
						result = pilotResult
						result.mode = "pilot"

						if (result.status === "passed") {
							const plan = recorder.finalize()
							await savePlan(cwd, plan)
							hashIndex[hashKey] = testHash
							hashIndexDirty = true
							await deletePartialPlan(cwd, suiteSlug, testSlug)
							await ensureGitignore(cwd)
							console.log(
								`    \x1b[32mCached plan generated for: ${test.name}\x1b[0m`,
							)
						} else {
							// Save partial plan so next run can resume from here
							const completed = result.completedInputSteps ?? 0
							const remaining = resumeSteps.slice(completed)
							if (remaining.length > 0 && completed > 0) {
								const partial = recorder.finalizePartial(remaining)
								await savePartialPlan(cwd, partial)
								await ensureGitignore(cwd)
								console.log(`    \x1b[33mPartial plan saved (${String(completed)}/${String(resumeSteps.length)} steps cached for next run)\x1b[0m`)
							}
						}
					}

					printTestSummary(result)

					if (config.headed) {
						await new Promise((r) => setTimeout(r, 2000))
					}

					globals.trace.detachFromPage(page)
					if (persistentContext) {
						// Persistent context is shared — close pages only
						for (const p of context.pages()) await p.close().catch(() => {})
					} else {
						await context.close()
					}
				} catch (err) {
					if (err instanceof LLMApiError) {
						console.error(
							`\n  \x1b[31mLLM API returned ${String(err.status)} — aborting test run.\x1b[0m`,
						)
						console.error(`  ${err.message}\n`)
						break
					}
					throw err
				}
			}
		} finally {
			if (hashIndexDirty) {
				await saveHashIndex(cwd, hashIndex)
			}
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- browser is guaranteed non-null when persistentContext is null
			await closeBrowser(persistentContext ?? browser!)
		}
	}
}
