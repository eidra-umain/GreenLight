// GreenLight E2E Testing
// Copyright (c) 2026 Umain AB Sweden
//
// This program is free software: you can redistribute it and/or
// modify it under the terms of the GNU General Public License as
// published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

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
