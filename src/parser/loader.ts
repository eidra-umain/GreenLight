import { readFile } from "node:fs/promises"
import { parse as parseYaml } from "yaml"
import { SuiteSchema, type Suite, type TestCase } from "./schema.js"
import { interpolateSteps } from "./variables.js"

/**
 * Load a suite YAML file: parse, validate, expand reusable steps, interpolate variables.
 * Returns a fully resolved Suite ready for execution.
 */
export async function loadSuite(filePath: string): Promise<Suite> {
	const raw = await readFile(filePath, "utf-8")
	const parsed: unknown = parseYaml(raw)

	// Validate against schema
	const suite = SuiteSchema.parse(parsed)

	const variables = suite.variables ?? {}
	const reusableSteps = suite.reusable_steps ?? {}

	// Expand reusable steps and interpolate variables for each test case
	const resolvedTests: TestCase[] = suite.tests.map((test) => {
		const expanded = expandReusableSteps(test.steps, reusableSteps)
		const interpolated = interpolateSteps(expanded, variables)
		return { ...test, steps: interpolated }
	})

	return { ...suite, tests: resolvedTests }
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
			// Recurse in case reusable steps reference other reusable steps
			const expanded = expandReusableSteps(reusableSteps[step], reusableSteps)
			result.push(...expanded)
		} else {
			result.push(step)
		}
	}
	return result
}
