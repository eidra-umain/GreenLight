import { describe, it, expect } from "vitest"
import { parseActionResponse, parsePlanResponse, validatePlanReferences, extractComparisonFromText } from "../../src/pilot/response-parser.js"
import { buildCompactMessage } from "../../src/pilot/message-builder.js"
import type { PageState } from "../../src/reporter/types.js"

// ── parsePlanResponse: REMEMBER / COMPARE ────────────────────────────

describe("parsePlanResponse — REMEMBER", () => {
	it("parses a REMEMBER line", () => {
		const result = parsePlanResponse(
			'REMEMBER "the number of products shown" as "product_count"',
		)
		expect(result).toHaveLength(1)
		expect(result[0].step).toBe("the number of products shown")
		expect(result[0].action).toBeNull()
		expect(result[0].rememberAs).toBe("product_count")
	})

	it("parses REMEMBER case-insensitively", () => {
		const result = parsePlanResponse(
			'remember "total price" as "price"',
		)
		expect(result[0].rememberAs).toBe("price")
		expect(result[0].step).toBe("total price")
	})

	it("does not set rememberAs on non-REMEMBER steps", () => {
		const result = parsePlanResponse('PAGE "click the button"')
		expect(result[0].rememberAs).toBeUndefined()
	})
})

describe("parsePlanResponse — COMPARE", () => {
	it("parses a COMPARE line as null action with compare metadata", () => {
		const result = parsePlanResponse(
			'COMPARE "the number of products shown" "less_than" remembered "product_count"',
		)
		expect(result).toHaveLength(1)
		// COMPARE needs runtime resolution (action is null)
		expect(result[0].action).toBeNull()
		expect(result[0].step).toBe("the number of products shown")
		expect(result[0].compare).toEqual({
			variable: "product_count",
			operator: "less_than",
		})
	})

	it("parses all comparison operators", () => {
		const operators = [
			"less_than",
			"greater_than",
			"equal",
			"not_equal",
			"less_or_equal",
			"greater_or_equal",
		]
		for (const op of operators) {
			const result = parsePlanResponse(
				`COMPARE "value" "${op}" remembered "var"`,
			)
			expect(result[0].compare!.operator).toBe(op)
		}
	})

	it("parses COMPARE case-insensitively", () => {
		const result = parsePlanResponse(
			'compare "count" "greater_than" remembered "old_count"',
		)
		expect(result[0].compare!.variable).toBe("old_count")
		expect(result[0].compare!.operator).toBe("greater_than")
	})
})

describe("parsePlanResponse — mixed plan with REMEMBER/COMPARE", () => {
	it("parses a full plan with remember and compare", () => {
		const raw = [
			'REMEMBER "the result count" as "count_before"',
			'PAGE "select Red in the color filter"',
			'COMPARE "the result count" "less_than" remembered "count_before"',
		].join("\n")
		const result = parsePlanResponse(raw)
		expect(result).toHaveLength(3)

		// REMEMBER
		expect(result[0].rememberAs).toBe("count_before")
		expect(result[0].action).toBeNull()
		expect(result[0].step).toBe("the result count")

		// PAGE
		expect(result[1].action).toBeNull()
		expect(result[1].rememberAs).toBeUndefined()

		// COMPARE — null action, compare metadata on step
		expect(result[2].action).toBeNull()
		expect(result[2].compare!.variable).toBe("count_before")
		expect(result[2].compare!.operator).toBe("less_than")
	})
})

// ── parsePlanResponse: COMPARE_VALUE ─────────────────────────────────

describe("parsePlanResponse — COMPARE_VALUE", () => {
	it("parses a COMPARE_VALUE line with literal", () => {
		const result = parsePlanResponse(
			'COMPARE_VALUE "the count of products shown" "greater_than" "0"',
		)
		expect(result).toHaveLength(1)
		expect(result[0].action).toBeNull()
		expect(result[0].step).toBe("the count of products shown")
		expect(result[0].compare).toEqual({
			variable: "_",
			operator: "greater_than",
			literal: "0",
		})
	})

	it("parses COMPARE_VALUE case-insensitively", () => {
		const result = parsePlanResponse(
			'compare_value "the number of items" "equal" "5"',
		)
		expect(result[0].compare).toEqual({
			variable: "_",
			operator: "equal",
			literal: "5",
		})
	})

	it("parses COMPARE_VALUE with all operators", () => {
		const operators = [
			"less_than",
			"greater_than",
			"equal",
			"not_equal",
			"less_or_equal",
			"greater_or_equal",
		]
		for (const op of operators) {
			const result = parsePlanResponse(
				`COMPARE_VALUE "value" "${op}" "10"`,
			)
			expect(result[0].compare!.operator).toBe(op)
			expect(result[0].compare!.literal).toBe("10")
		}
	})

	it("works in a mixed plan without REMEMBER", () => {
		const raw = [
			'navigate "/products"',
			'PAGE "wait for products to load"',
			'COMPARE_VALUE "the count of products shown" "greater_than" "0"',
		].join("\n")
		const result = parsePlanResponse(raw)
		expect(result).toHaveLength(3)
		expect(result[2].compare!.literal).toBe("0")
		expect(result[2].compare!.operator).toBe("greater_than")
	})
})

// ── parsePlanResponse: assert numeric ────────────────────────────────

describe("parsePlanResponse — assert numeric", () => {
	it("parses assert numeric and extracts comparison from text", () => {
		const result = parsePlanResponse(
			'assert numeric "check that the count of products shown is greater than 0"',
		)
		expect(result).toHaveLength(1)
		expect(result[0].action).toBeNull()
		expect(result[0].compare).toEqual({
			variable: "_",
			operator: "greater_than",
			literal: "0",
		})
	})

	it("parses assert numeric with 'at least'", () => {
		const result = parsePlanResponse(
			'assert numeric "verify there are at least 5 results"',
		)
		expect(result[0].compare).toEqual({
			variable: "_",
			operator: "greater_or_equal",
			literal: "5",
		})
	})

	it("falls back to PAGE-like when no comparison found", () => {
		const result = parsePlanResponse(
			'assert numeric "check that products are displayed"',
		)
		expect(result[0].compare).toBeUndefined()
		expect(result[0].action).toBeNull()
	})

	it("works in a mixed plan", () => {
		const raw = [
			'PAGE "click Köksblandare"',
			'assert numeric "check that the count of products shown is greater than 0"',
			'PAGE "click on the first product"',
			'assert contains_text "Din varukorg är tom"',
		].join("\n")
		const result = parsePlanResponse(raw)
		expect(result).toHaveLength(4)
		expect(result[0].action).toBeNull() // PAGE
		expect(result[1].compare!.operator).toBe("greater_than")
		expect(result[1].compare!.literal).toBe("0")
		expect(result[2].action).toBeNull() // PAGE
		expect(result[3].action!.assertion!.type).toBe("contains_text")
	})
})

// ── parsePlanResponse: COMPARE_VALUE simple syntax ───────────────────

describe("parsePlanResponse — COMPARE_VALUE simple syntax", () => {
	it("parses simple COMPARE_VALUE and extracts operator + literal from text", () => {
		const result = parsePlanResponse(
			'COMPARE_VALUE "check that the count of products shown is greater than 0"',
		)
		expect(result).toHaveLength(1)
		expect(result[0].action).toBeNull()
		expect(result[0].compare).toEqual({
			variable: "_",
			operator: "greater_than",
			literal: "0",
		})
	})

	it("extracts 'at least' as greater_or_equal", () => {
		const result = parsePlanResponse(
			'COMPARE_VALUE "verify there are at least 3 results"',
		)
		expect(result[0].compare).toEqual({
			variable: "_",
			operator: "greater_or_equal",
			literal: "3",
		})
	})

	it("extracts 'less than' operator", () => {
		const result = parsePlanResponse(
			'COMPARE_VALUE "check that the count is less than 10"',
		)
		expect(result[0].compare).toEqual({
			variable: "_",
			operator: "less_than",
			literal: "10",
		})
	})

	it("extracts 'equals' operator", () => {
		const result = parsePlanResponse(
			'COMPARE_VALUE "check that the number of items equals 5"',
		)
		expect(result[0].compare).toEqual({
			variable: "_",
			operator: "equal",
			literal: "5",
		})
	})

	it("falls back to PAGE-like step when no comparison found in text", () => {
		const result = parsePlanResponse(
			'COMPARE_VALUE "check that products are shown"',
		)
		expect(result[0].compare).toBeUndefined()
		expect(result[0].action).toBeNull()
	})
})

// ── extractComparisonFromText ────────────────────────────────────────

describe("extractComparisonFromText", () => {
	it("extracts 'greater than N'", () => {
		expect(extractComparisonFromText("the count is greater than 0")).toEqual({ operator: "greater_than", literal: "0" })
	})

	it("extracts 'less than N'", () => {
		expect(extractComparisonFromText("value is less than 100")).toEqual({ operator: "less_than", literal: "100" })
	})

	it("extracts 'at least N'", () => {
		expect(extractComparisonFromText("at least 5 items")).toEqual({ operator: "greater_or_equal", literal: "5" })
	})

	it("extracts 'at most N'", () => {
		expect(extractComparisonFromText("at most 20 results")).toEqual({ operator: "less_or_equal", literal: "20" })
	})

	it("extracts 'equals N'", () => {
		expect(extractComparisonFromText("count equals 10")).toEqual({ operator: "equal", literal: "10" })
	})

	it("extracts 'equal to N'", () => {
		expect(extractComparisonFromText("count is equal to 7")).toEqual({ operator: "equal", literal: "7" })
	})

	it("extracts 'more than N'", () => {
		expect(extractComparisonFromText("more than 3 products")).toEqual({ operator: "greater_than", literal: "3" })
	})

	it("extracts 'fewer than N'", () => {
		expect(extractComparisonFromText("fewer than 2 items")).toEqual({ operator: "less_than", literal: "2" })
	})

	it("extracts decimal numbers", () => {
		expect(extractComparisonFromText("greater than 3.5")).toEqual({ operator: "greater_than", literal: "3.5" })
	})

	it("returns null when no comparison pattern found", () => {
		expect(extractComparisonFromText("check that products are visible")).toBeNull()
	})

	it("returns null for empty string", () => {
		expect(extractComparisonFromText("")).toBeNull()
	})
})

// ── validatePlanReferences ───────────────────────────────────────────

describe("validatePlanReferences", () => {
	it("returns no errors for valid plan", () => {
		const plan = parsePlanResponse([
			'REMEMBER "count" as "before_count"',
			'PAGE "click filter"',
			'COMPARE "count" "less_than" remembered "before_count"',
		].join("\n"))
		expect(validatePlanReferences(plan)).toEqual([])
	})

	it("returns error when COMPARE references missing REMEMBER", () => {
		const plan = parsePlanResponse(
			'COMPARE "count" "less_than" remembered "nonexistent"',
		)
		const errors = validatePlanReferences(plan)
		expect(errors).toHaveLength(1)
		expect(errors[0]).toContain("nonexistent")
	})

	it("returns error when COMPARE appears before its REMEMBER", () => {
		const plan = parsePlanResponse([
			'COMPARE "count" "less_than" remembered "total"',
			'REMEMBER "count" as "total"',
		].join("\n"))
		const errors = validatePlanReferences(plan)
		expect(errors).toHaveLength(1)
		expect(errors[0]).toContain("total")
	})

	it("handles multiple REMEMBER/COMPARE pairs", () => {
		const plan = parsePlanResponse([
			'REMEMBER "price" as "price_before"',
			'REMEMBER "count" as "count_before"',
			'PAGE "apply filter"',
			'COMPARE "price" "equal" remembered "price_before"',
			'COMPARE "count" "less_than" remembered "count_before"',
		].join("\n"))
		expect(validatePlanReferences(plan)).toEqual([])
	})

	it("returns no errors for plan with no COMPARE steps", () => {
		const plan = parsePlanResponse([
			'PAGE "click button"',
			'assert contains_text "Hello"',
		].join("\n"))
		expect(validatePlanReferences(plan)).toEqual([])
	})

	it("allows REMEMBER without matching COMPARE (unused is fine)", () => {
		const plan = parsePlanResponse(
			'REMEMBER "count" as "unused_var"',
		)
		expect(validatePlanReferences(plan)).toEqual([])
	})

	it("returns no errors for COMPARE_VALUE (literal, no REMEMBER needed)", () => {
		const plan = parsePlanResponse(
			'COMPARE_VALUE "product count" "greater_than" "0"',
		)
		expect(validatePlanReferences(plan)).toEqual([])
	})

	it("handles mix of COMPARE and COMPARE_VALUE", () => {
		const plan = parsePlanResponse([
			'REMEMBER "count" as "before_count"',
			'PAGE "apply filter"',
			'COMPARE "count" "less_than" remembered "before_count"',
			'COMPARE_VALUE "count" "greater_than" "0"',
		].join("\n"))
		expect(validatePlanReferences(plan)).toEqual([])
	})
})

// ── parseActionResponse: remember and compare fields ─────────────────

describe("parseActionResponse — remember action", () => {
	it("parses a remember action", () => {
		const action = parseActionResponse(
			'remember ref=e15 as="product_count"',
		)
		expect(action.action).toBe("remember")
		expect(action.ref).toBe("e15")
		expect(action.rememberAs).toBe("product_count")
	})
})

describe("parseActionResponse — compare assertion", () => {
	it("parses a compare assertion", () => {
		const action = parseActionResponse(
			'assert compare "product count" ref=e15 variable="count_before" operator="less_than"',
		)
		expect(action.action).toBe("assert")
		expect(action.assertion).toEqual({
			type: "compare",
			expected: "product count",
		})
		expect(action.compare).toEqual({
			variable: "count_before",
			operator: "less_than",
		})
	})

	it("parses compare with all operators", () => {
		const operators = [
			"less_than",
			"greater_than",
			"equal",
			"not_equal",
		]
		for (const op of operators) {
			const action = parseActionResponse(
				`assert compare "x" variable="v" operator="${op}"`,
			)
			expect(action.compare!.operator).toBe(op)
		}
	})

	it("parses a compare assertion with literal value", () => {
		const action = parseActionResponse(
			'assert compare "product count" ref=e15 variable="_" operator="greater_than" literal="0"',
		)
		expect(action.compare).toEqual({
			variable: "_",
			operator: "greater_than",
			literal: "0",
		})
	})

	it("does not set literal when not present", () => {
		const action = parseActionResponse(
			'assert compare "x" variable="v" operator="equal"',
		)
		expect(action.compare!.literal).toBeUndefined()
	})
})

// ── buildCompactMessage ──────────────────────────────────────────────

describe("buildCompactMessage", () => {
	const basePage: PageState = {
		a11yTree: [
			{ ref: "e1", role: "button", name: "Submit", raw: '- button "Submit"' },
			{ ref: "e2", role: "textbox", name: "Email", raw: '- textbox "Email"' },
		],
		a11yRaw: "",
		url: "https://example.com/page",
		title: "Test Page",
		consoleLogs: [],
	}

	it("returns 'unchanged' when tree is identical", () => {
		const result = buildCompactMessage(
			"click submit",
			basePage,
			basePage,
			'[e1] button "Submit"\n[e2] textbox "Email"',
		)
		expect(result).not.toBeNull()
		expect(result!.mode).toBe("unchanged")
		expect(result!.message).toContain("unchanged")
		expect(result!.message).toContain("click submit")
		expect(result!.message).not.toContain("button")
	})

	it("returns null when URL path changed", () => {
		const otherPage = { ...basePage, url: "https://example.com/other" }
		const result = buildCompactMessage(
			"click submit",
			otherPage,
			basePage,
			'[e1] button "Submit"',
		)
		expect(result).toBeNull()
	})

	it("returns 'tree-diff' when small change in tree", () => {
		// Need enough base lines so adding one stays under 30% change ratio
		const manyNodes = Array.from({ length: 10 }, (_, i) => ({
			ref: `e${String(i + 1)}`,
			role: "link",
			name: `Link ${String(i)}`,
			raw: `- link "Link ${String(i)}"`,
		}))
		const bigPage: PageState = {
			...basePage,
			a11yTree: manyNodes,
		}
		const newNodes = [
			...manyNodes,
			{ ref: "e20", role: "button", name: "Cancel", raw: '- button "Cancel"' },
		]
		const newPage: PageState = { ...basePage, a11yTree: newNodes }
		const prevTree = manyNodes.map((n) => `[${n.ref}] ${n.role} "${n.name}"`).join("\n")
		const result = buildCompactMessage("click cancel", newPage, bigPage, prevTree)
		expect(result).not.toBeNull()
		expect(result!.mode).toBe("tree-diff")
		expect(result!.message).toContain("Cancel")
		expect(result!.message).toContain("click cancel")
	})

	it("returns 'tree-only' when many lines changed", () => {
		// Create a page where >30% of lines differ
		const manyNodes = Array.from({ length: 20 }, (_, i) => ({
			ref: `e${String(i + 100)}`,
			role: "link",
			name: `Link ${String(i)}`,
			raw: `- link "Link ${String(i)}"`,
		}))
		const newPage: PageState = {
			...basePage,
			a11yTree: manyNodes,
		}
		const prevTree = '[e1] button "Submit"\n[e2] textbox "Email"'
		const result = buildCompactMessage("click something", newPage, basePage, prevTree)
		expect(result).not.toBeNull()
		expect(result!.mode).toBe("tree-only")
		// Should contain the full tree
		expect(result!.message).toContain("Link 0")
		expect(result!.message).toContain("Link 19")
	})
})
