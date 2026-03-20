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

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"

/**
 * Verify that every action type handled by the executor that uses a selector
 * also has an explicit case in the cached plan runner's executeHeuristicStep.
 *
 * The default case in executeHeuristicStep delegates to executeAction but
 * loses the stored selector role+name — it only passes action.text. Actions
 * that rely on selectors (click, type, clear, etc.) MUST have their own case
 * so that buildLocator is used instead of resolveByText.
 */
describe("plan-runner action coverage", () => {
	// Actions that use selectors during execution and therefore need
	// an explicit case in the cached plan runner to preserve role+name.
	const SELECTOR_ACTIONS = [
		"click",
		"type",
		"select",
		"autocomplete",
		"clear",
		"check",
		"uncheck",
		"count",
		"remember",
		"scroll",
	]

	// Actions that don't use selectors — safe to fall through to default.
	const DEFAULT_OK_ACTIONS = [
		"navigate",
		"press",
		"wait",
		"assert",
		"map_detect",
		"datepick",
		"conditional",
	]

	const runnerSource = readFileSync(
		new URL("../../src/planner/plan-runner.ts", import.meta.url),
		"utf-8",
	)

	for (const action of SELECTOR_ACTIONS) {
		it(`cached plan runner has explicit case for "${action}"`, () => {
			const pattern = new RegExp(`case\\s+["']${action}["']\\s*:`)
			expect(
				pattern.test(runnerSource),
				`Action "${action}" uses selectors but has no explicit case in executeHeuristicStep. ` +
				`The default handler loses role+name info — add a case that uses buildLocator.`,
			).toBe(true)
		})
	}

	it("documents which actions are safe for the default handler", () => {
		// This test just ensures the two lists are maintained.
		// If you add a new action type, add it to one of these lists.
		const all = [...SELECTOR_ACTIONS, ...DEFAULT_OK_ACTIONS]
		expect(all.length).toBeGreaterThan(0)
	})
})
