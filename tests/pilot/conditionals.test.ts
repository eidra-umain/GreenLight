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
import { parsePlanResponse } from "../../src/pilot/response-parser.js"

// ── IF_VISIBLE / IF_CONTAINS / IF_URL ────────────────────────────────

describe("parsePlanResponse — conditionals", () => {
	it("parses IF_VISIBLE with THEN", () => {
		const result = parsePlanResponse(
			'IF_VISIBLE "Accept cookies" THEN PAGE "click Accept cookies"',
		)
		expect(result).toHaveLength(1)
		expect(result[0].condition).toEqual({ type: "visible", target: "Accept cookies" })
		expect(result[0].thenBranch).toHaveLength(1)
		expect(result[0].thenBranch?.[0].step).toBe("click Accept cookies")
		expect(result[0].elseBranch).toBeUndefined()
	})

	it("parses IF_VISIBLE with THEN and ELSE", () => {
		const result = parsePlanResponse(
			'IF_VISIBLE "Out of stock" THEN PAGE "click Notify me" ELSE PAGE "click Add to cart"',
		)
		expect(result).toHaveLength(1)
		expect(result[0].condition?.type).toBe("visible")
		expect(result[0].thenBranch?.[0].step).toBe("click Notify me")
		expect(result[0].elseBranch?.[0].step).toBe("click Add to cart")
	})

	it("parses IF_CONTAINS", () => {
		const result = parsePlanResponse(
			'IF_CONTAINS "Welcome" THEN assert contains_text "Welcome"',
		)
		expect(result[0].condition?.type).toBe("contains")
		expect(result[0].condition?.target).toBe("Welcome")
		expect(result[0].thenBranch?.[0].action?.action).toBe("assert")
	})

	it("parses IF_URL", () => {
		const result = parsePlanResponse(
			'IF_URL "/login" THEN assert contains_text "Sign in"',
		)
		expect(result[0].condition?.type).toBe("url")
		expect(result[0].condition?.target).toBe("/login")
	})

	it("is case-insensitive", () => {
		const result = parsePlanResponse(
			'if_visible "Skip" THEN PAGE "click Skip"',
		)
		expect(result[0].condition?.type).toBe("visible")
	})

	it("handles pre-resolved THEN actions", () => {
		const result = parsePlanResponse(
			'IF_VISIBLE "Submit" THEN navigate "/home"',
		)
		expect(result[0].thenBranch?.[0].action?.action).toBe("navigate")
		expect(result[0].thenBranch?.[0].action?.value).toBe("/home")
	})
})

// ── Multiple conditionals with same condition ────────────────────────

describe("parsePlanResponse — multiple conditionals", () => {
	it("parses multiple lines with the same condition", () => {
		const result = parsePlanResponse(
			[
				'IF_VISIBLE "password" THEN PAGE "type secret into the password field"',
				'IF_VISIBLE "password" THEN PAGE "click the unlock button"',
			].join("\n"),
		)
		expect(result).toHaveLength(2)
		expect(result[0].condition?.target).toBe("password")
		expect(result[1].condition?.target).toBe("password")
	})
})

// ── DATEPICK ─────────────────────────────────────────────────────────

describe("parsePlanResponse — DATEPICK", () => {
	it("parses DATEPICK with description and time expression", () => {
		const result = parsePlanResponse(
			'DATEPICK "set the start time to 10 minutes from now" "10 minutes from now"',
		)
		expect(result).toHaveLength(1)
		expect(result[0].needsDatePick).toBe(true)
		expect(result[0].step).toBe("set the start time to 10 minutes from now||10 minutes from now")
	})

	it("parses DATEPICK with single quoted string (fallback)", () => {
		const result = parsePlanResponse(
			'DATEPICK "set the date to tomorrow"',
		)
		expect(result[0].needsDatePick).toBe(true)
		expect(result[0].step).toBe("set the date to tomorrow")
	})
})

// ── ASSERT_REMEMBERED ────────────────────────────────────────────────

describe("parsePlanResponse — ASSERT_REMEMBERED", () => {
	it("parses ASSERT_REMEMBERED into a contains_remembered assertion", () => {
		const result = parsePlanResponse('ASSERT_REMEMBERED "booking_name"')
		expect(result).toHaveLength(1)
		expect(result[0].action?.action).toBe("assert")
		expect(result[0].action?.assertion?.type).toBe("contains_remembered")
		expect(result[0].action?.assertion?.expected).toBe("booking_name")
		expect(result[0].action?.compare?.variable).toBe("booking_name")
	})
})

// ── #N input step index prefix ───────────────────────────────────────

describe("parsePlanResponse — #N prefix", () => {
	it("extracts input step index from #N prefix", () => {
		const result = parsePlanResponse(
			[
				'#1 PAGE "click Sign in"',
				'#2 PAGE "type email"',
				'#2 PAGE "click Login"',
				"#3 assert contains_text \"Welcome\"",
			].join("\n"),
		)
		expect(result).toHaveLength(4)
		expect(result[0].inputStepIndex).toBe(0) // #1 → 0-based
		expect(result[1].inputStepIndex).toBe(1)
		expect(result[2].inputStepIndex).toBe(1) // same input step
		expect(result[3].inputStepIndex).toBe(2)
	})

	it("works without #N prefix (inputStepIndex undefined)", () => {
		const result = parsePlanResponse('PAGE "click button"')
		expect(result[0].inputStepIndex).toBeUndefined()
	})

	it("strips the #N prefix from the step text", () => {
		const result = parsePlanResponse('#1 PAGE "click the button"')
		expect(result[0].step).toBe("click the button")
		expect(result[0].action).toBeNull()
	})

	it("works with conditional steps", () => {
		const result = parsePlanResponse(
			'#3 IF_VISIBLE "Skip" THEN PAGE "click Skip"',
		)
		expect(result[0].inputStepIndex).toBe(2)
		expect(result[0].condition?.target).toBe("Skip")
	})

	it("works with DATEPICK", () => {
		const result = parsePlanResponse(
			'#5 DATEPICK "set start to tomorrow" "tomorrow"',
		)
		expect(result[0].inputStepIndex).toBe(4)
		expect(result[0].needsDatePick).toBe(true)
	})
})
