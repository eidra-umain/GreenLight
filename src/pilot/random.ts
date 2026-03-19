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
 * Random value injection for test steps.
 *
 * When a step contains "random", we generate truly random values and
 * inject them into the step prompt so the LLM uses them. When caching
 * heuristic steps, the actual values are replaced with placeholders
 * that get fresh values on each cached replay.
 */

import { humanId } from "human-id"

export const RANDOM_NUMBER_PLACEHOLDER = "__RANDOM_NUMBER__"
export const RANDOM_STRING_PLACEHOLDER = "__RANDOM_STRING__"

/** A pair of random values for injection into step prompts. */
export interface RandomValues {
	number: string
	string: string
}

/** Generate a fresh pair of random values. */
export function generateRandomValues(): RandomValues {
	const num = String(Math.floor(100000 + Math.random() * 900000))
	const str = humanId({ separator: "-", capitalize: false })
	return { number: num, string: str }
}

/** Check whether a step text mentions "random". */
export function stepNeedsRandom(step: string): boolean {
	return /\brandom\b/i.test(step)
}

/**
 * Augment a step prompt with random values so the LLM uses them.
 * Returns the augmented step text and the values used.
 */
export function injectRandomValues(step: string): { step: string; values: RandomValues } {
	const values = generateRandomValues()
	const augmented = `${step} (use these random values: number="${values.number}", string="${values.string}")`
	return { step: augmented, values }
}

/**
 * Replace actual random values in a heuristic step's value field with
 * placeholders, so cached replays generate fresh values.
 */
export function replaceWithPlaceholders(value: string, values: RandomValues): string {
	let result = value
	if (values.number) result = result.replace(values.number, RANDOM_NUMBER_PLACEHOLDER)
	if (values.string) result = result.replace(values.string, RANDOM_STRING_PLACEHOLDER)
	return result
}

/**
 * Replace placeholders in a cached step's value with fresh random values.
 */
export function hydratePlaceholders(value: string): string {
	let result = value
	if (result.includes(RANDOM_NUMBER_PLACEHOLDER) || result.includes(RANDOM_STRING_PLACEHOLDER)) {
		const fresh = generateRandomValues()
		result = result.replace(RANDOM_NUMBER_PLACEHOLDER, fresh.number)
		result = result.replace(RANDOM_STRING_PLACEHOLDER, fresh.string)
	}
	return result
}
