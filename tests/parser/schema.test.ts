import { describe, it, expect } from "vitest"
import { SuiteSchema } from "../../src/parser/schema.js"

describe("SuiteSchema", () => {
	const minimal = {
		suite: "Test",
		base_url: "https://example.com",
		tests: [{ name: "T1", steps: ["click button"] }],
	}

	it("accepts a minimal valid suite", () => {
		const result = SuiteSchema.parse(minimal)
		expect(result.suite).toBe("Test")
		expect(result.tests).toHaveLength(1)
	})

	it("accepts a full suite with all optional fields", () => {
		const full = {
			...minimal,
			viewport: { width: 1024, height: 768 },
			variables: { user: "alice" },
			reusable_steps: { login: ["click Sign In"] },
		}
		const result = SuiteSchema.parse(full)
		expect(result.viewport).toEqual({ width: 1024, height: 768 })
		expect(result.variables).toEqual({ user: "alice" })
		expect(result.reusable_steps).toEqual({ login: ["click Sign In"] })
	})

	it("rejects missing suite name", () => {
		const { suite: _, ...noName } = minimal
		expect(() => SuiteSchema.parse(noName)).toThrow()
	})

	it("ignores unknown fields like base_url (removed from suite schema)", () => {
		// base_url was removed from suite schema — it's now only in greenlight.yaml
		const result = SuiteSchema.parse({ ...minimal, base_url: "not-a-url" })
		expect(result.suite).toBe("Test")
	})

	it("rejects empty tests array", () => {
		expect(() => SuiteSchema.parse({ ...minimal, tests: [] })).toThrow()
	})

	it("rejects test with empty steps", () => {
		expect(() =>
			SuiteSchema.parse({
				...minimal,
				tests: [{ name: "T", steps: [] }],
			}),
		).toThrow()
	})

	it("rejects test with empty step string", () => {
		expect(() =>
			SuiteSchema.parse({
				...minimal,
				tests: [{ name: "T", steps: [""] }],
			}),
		).toThrow()
	})

	it("rejects invalid viewport dimensions", () => {
		expect(() =>
			SuiteSchema.parse({
				...minimal,
				viewport: { width: -1, height: 768 },
			}),
		).toThrow()
	})

	it("preserves optional description on test case", () => {
		const result = SuiteSchema.parse({
			...minimal,
			tests: [{ name: "T", description: "A test", steps: ["click x"] }],
		})
		expect(result.tests[0].description).toBe("A test")
	})
})
