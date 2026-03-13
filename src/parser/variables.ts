/**
 * Variable interpolation for suite definitions.
 *
 * Resolves patterns like:
 *   {{varName}}        → from suite-level variables
 *   {{env.VAR_NAME}}   → from process.env
 *   {{timestamp}}       → current unix timestamp
 */

const PATTERN = /\{\{(.+?)\}\}/g

/**
 * Resolve all `{{...}}` references in a string.
 * Throws if a variable cannot be resolved.
 */
export function interpolate(
	template: string,
	variables: Record<string, string>,
): string {
	return template.replace(PATTERN, (_match, key: string) => {
		const trimmed = key.trim()

		// Built-in: timestamp
		if (trimmed === "timestamp") {
			return String(Date.now())
		}

		// Environment variable: env.X
		if (trimmed.startsWith("env.")) {
			const envKey = trimmed.slice(4)
			const value = process.env[envKey]
			if (value === undefined) {
				throw new Error(
					`Environment variable "${envKey}" is not set (referenced as "{{${trimmed}}}")`,
				)
			}
			return value
		}

		// Suite-level variable
		if (!(trimmed in variables)) {
			throw new Error(
				`Unknown variable "{{${trimmed}}}". ` +
					`Available: ${Object.keys(variables).join(", ") || "(none)"}`,
			)
		}
		return variables[trimmed]
	})
}

/**
 * Resolve variables in all steps of a suite (mutates nothing — returns a new array).
 */
export function interpolateSteps(
	steps: string[],
	variables: Record<string, string>,
): string[] {
	return steps.map((step) => interpolate(step, variables))
}
