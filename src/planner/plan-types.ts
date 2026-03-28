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
 * Types for cached heuristic test plans.
 * A heuristic plan is a concrete, element-bound action sequence
 * derived from a successful discovery run, replayable without LLM calls.
 */

/** How to locate an element during cached plan replay. */
export interface HeuristicSelector {
	/** ARIA role from the a11y tree (for ref-based resolution). */
	role?: string
	/** Accessible name from the a11y tree. */
	name?: string
	/** CSS DOM selector extracted from the element (for text-based fallback resolution). */
	css?: string
	/** Zero-based index when multiple elements match the same role+name. */
	nth?: number
}

/** A single concrete step in a heuristic plan. */
export interface HeuristicStep {
	/** The original natural-language step text. */
	originalStep: string
	/** The action type (click, type, select, scroll, navigate, press, wait, assert, conditional). */
	action: string
	/** Element selector — undefined for actions without a target (navigate, press, assert, etc.). */
	selector?: HeuristicSelector
	/** Value: text to type, URL to navigate, key to press, scroll direction, etc. */
	value?: string
	/** data-testid attribute value for direct element targeting (used by upload). */
	testid?: string
	/** For autocomplete actions: the specific suggestion to select. */
	option?: string
	/** For remember actions: the variable name to store the captured value. */
	rememberAs?: string
	/** Assertion details for assert actions. */
	assertion?: { type: string; expected: string }
	/** For compare assertions: the comparison metadata. */
	compare?: { variable: string; operator: string; literal?: string }
	/** For conditional steps: the condition to evaluate at runtime. */
	condition?: { type: string; target: string }
	/** For conditional steps: concrete steps for the then branch. */
	thenSteps?: HeuristicStep[]
	/** For conditional steps: concrete steps for the else branch. */
	elseSteps?: HeuristicStep[]
	/** Which branch was taken during the discovery run (for drift detection). */
	discoveryBranch?: "then" | "else" | "skipped"
	/** Page state after the step executed, for drift detection. */
	postStepFingerprint: {
		url: string
		title: string
	}
}

/** A complete or partial cached plan for one test case. */
export interface HeuristicPlan {
	/** Slugified suite name (used as directory). */
	suiteSlug: string
	/** Slugified test case name (used as filename). */
	testSlug: string
	/** SHA-256 hash of the test case's effective definition (resolved steps). */
	sourceHash: string
	/** LLM model used during the discovery run. */
	model: string
	/** ISO 8601 timestamp of plan generation. */
	generatedAt: string
	/** GreenLight version that generated the plan. */
	greenlightVersion: string
	/** The concrete steps to replay. */
	steps: HeuristicStep[]
	/** If true, this plan is from a failed run and only covers steps up to the failure. */
	partial?: boolean
	/** Original test input steps remaining after this partial plan (for resuming). */
	remainingSteps?: string[]
}
