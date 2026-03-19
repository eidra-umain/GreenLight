import { readFile } from "node:fs/promises"
import { parse as parseYaml } from "yaml"
import { SuiteSchema, type Suite, type Step, type ConditionalStep } from "./schema.js"
import { interpolateSteps } from "./variables.js"

/** Resolved suite with steps flattened to plain strings. */
export interface ResolvedSuite extends Omit<Suite, "tests"> {
	tests: { name: string; description?: string; steps: string[] }[]
}

/**
 * Load a suite YAML file: parse, validate, expand reusable steps,
 * flatten block conditionals, and interpolate variables.
 * Returns a fully resolved Suite with all steps as plain strings.
 */
export async function loadSuite(filePath: string): Promise<ResolvedSuite> {
	const raw = await readFile(filePath, "utf-8")
	const parsed: unknown = parseYaml(raw)

	// Validate against schema
	const suite = SuiteSchema.parse(parsed)

	const variables = suite.variables ?? {}
	const reusableSteps = suite.reusable_steps ?? {}

	// Expand reusable steps, flatten conditionals, and interpolate variables
	const resolvedTests = suite.tests.map((test) => {
		const flattened = flattenSteps(test.steps)
		const expanded = expandReusableSteps(flattened, reusableSteps)
		const interpolated = interpolateSteps(expanded, variables)
		return { ...test, steps: interpolated }
	})

	return { ...suite, tests: resolvedTests }
}

/**
 * Flatten block conditionals into inline conditional strings.
 *
 * Converts:
 *   { if: "cookie banner visible", then: ["click Accept", "wait"], else: ["check list"] }
 * Into:
 *   "if cookie banner visible then click Accept"
 *   "if cookie banner visible then wait"
 *   (else branch not yet supported for multi-step — see below)
 *
 * For single-step branches, produces a proper inline conditional:
 *   "if cookie banner visible then click Accept else check list"
 */
function flattenSteps(steps: Step[]): string[] {
	const result: string[] = []
	for (const step of steps) {
		if (typeof step === "string") {
			result.push(step)
		} else {
			// Block conditional → convert to inline conditional string(s)
			const cond = step as ConditionalStep
			if (cond.then.length === 1 && (!cond.else || cond.else.length <= 1)) {
				// Simple case: single-step branches → one inline conditional
				let inline = `if ${cond.if} then ${cond.then[0]}`
				if (cond.else && cond.else.length === 1) {
					inline += ` else ${cond.else[0]}`
				}
				result.push(inline)
			} else {
				// Multi-step then branch: emit one conditional per then-step
				for (const thenStep of cond.then) {
					result.push(`if ${cond.if} then ${thenStep}`)
				}
				// Multi-step else branch: emit one conditional per else-step
				// using negated condition (if NOT condition then else-step)
				if (cond.else) {
					for (const elseStep of cond.else) {
						result.push(`if not ${cond.if} then ${elseStep}`)
					}
				}
			}
		}
	}
	return result
}

/**
 * Expand reusable step references.
 * If a step string exactly matches a reusable step name, replace it
 * with that reusable step's list of steps (recursively).
 */
function expandReusableSteps(
	steps: string[],
	reusableSteps: Record<string, string[]>,
): string[] {
	const result: string[] = []
	for (const step of steps) {
		if (step in reusableSteps) {
			const expanded = expandReusableSteps(reusableSteps[step], reusableSteps)
			result.push(...expanded)
		} else {
			result.push(step)
		}
	}
	return result
}
