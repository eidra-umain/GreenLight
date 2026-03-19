import { describe, it, expect } from "vitest"
import {
	generateRandomValues,
	stepNeedsRandom,
	injectRandomValues,
	replaceWithPlaceholders,
	hydratePlaceholders,
	RANDOM_NUMBER_PLACEHOLDER,
	RANDOM_STRING_PLACEHOLDER,
} from "../../src/pilot/random.js"

describe("generateRandomValues", () => {
	it("returns a 6-digit number", () => {
		const { number } = generateRandomValues()
		expect(number).toMatch(/^\d{6}$/)
	})

	it("returns a non-empty string", () => {
		const { string } = generateRandomValues()
		expect(string.length).toBeGreaterThan(0)
	})

	it("generates different values on each call", () => {
		const a = generateRandomValues()
		const b = generateRandomValues()
		// Extremely unlikely to collide
		expect(a.number !== b.number || a.string !== b.string).toBe(true)
	})
})

describe("stepNeedsRandom", () => {
	it("returns true for steps containing 'random'", () => {
		expect(stepNeedsRandom("name the booking a random string")).toBe(true)
		expect(stepNeedsRandom("enter a Random email")).toBe(true)
		expect(stepNeedsRandom("fill with RANDOM data")).toBe(true)
	})

	it("returns false for steps without 'random'", () => {
		expect(stepNeedsRandom("click the submit button")).toBe(false)
		expect(stepNeedsRandom("enter 'test@example.com' into email")).toBe(false)
	})

	it("does not match 'random' as a substring", () => {
		expect(stepNeedsRandom("randomize is not a match")).toBe(false)
	})
})

describe("injectRandomValues", () => {
	it("appends random values to the step text", () => {
		const { step, values } = injectRandomValues("type a random string")
		expect(step).toContain("type a random string")
		expect(step).toContain(values.number)
		expect(step).toContain(values.string)
	})
})

describe("replaceWithPlaceholders", () => {
	it("replaces the number with placeholder", () => {
		const values = { number: "123456", string: "brave-tiger" }
		expect(replaceWithPlaceholders("Test-123456", values)).toBe(
			`Test-${RANDOM_NUMBER_PLACEHOLDER}`,
		)
	})

	it("replaces the string with placeholder", () => {
		const values = { number: "123456", string: "brave-tiger" }
		expect(replaceWithPlaceholders("brave-tiger", values)).toBe(
			RANDOM_STRING_PLACEHOLDER,
		)
	})

	it("replaces both in one value", () => {
		const values = { number: "123456", string: "brave-tiger" }
		expect(replaceWithPlaceholders("brave-tiger-123456", values)).toBe(
			`${RANDOM_STRING_PLACEHOLDER}-${RANDOM_NUMBER_PLACEHOLDER}`,
		)
	})

	it("leaves non-matching values unchanged", () => {
		const values = { number: "123456", string: "brave-tiger" }
		expect(replaceWithPlaceholders("something-else", values)).toBe("something-else")
	})
})

describe("hydratePlaceholders", () => {
	it("replaces number placeholder with a fresh 6-digit number", () => {
		const result = hydratePlaceholders(`Test-${RANDOM_NUMBER_PLACEHOLDER}`)
		expect(result).not.toContain(RANDOM_NUMBER_PLACEHOLDER)
		expect(result).toMatch(/^Test-\d{6}$/)
	})

	it("replaces string placeholder with a fresh string", () => {
		const result = hydratePlaceholders(RANDOM_STRING_PLACEHOLDER)
		expect(result).not.toContain(RANDOM_STRING_PLACEHOLDER)
		expect(result.length).toBeGreaterThan(0)
	})

	it("replaces both placeholders", () => {
		const result = hydratePlaceholders(
			`${RANDOM_STRING_PLACEHOLDER}-${RANDOM_NUMBER_PLACEHOLDER}`,
		)
		expect(result).not.toContain(RANDOM_STRING_PLACEHOLDER)
		expect(result).not.toContain(RANDOM_NUMBER_PLACEHOLDER)
	})

	it("leaves values without placeholders unchanged", () => {
		expect(hydratePlaceholders("normal-value")).toBe("normal-value")
	})

	it("generates different values on each call", () => {
		const a = hydratePlaceholders(RANDOM_NUMBER_PLACEHOLDER)
		const b = hydratePlaceholders(RANDOM_NUMBER_PLACEHOLDER)
		// Could collide in theory but astronomically unlikely
		expect(a).not.toBe(b)
	})
})
