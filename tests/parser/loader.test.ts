import { describe, it, expect, vi, afterEach } from "vitest"
import { loadSuite } from "../../src/parser/loader.js"
import { resolve } from "node:path"

const fixture = (name: string) =>
	resolve(import.meta.dirname, "../fixtures", name)

describe("loadSuite", () => {
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it("loads and parses a valid suite", async () => {
		const suite = await loadSuite(fixture("valid-suite.yaml"))
		expect(suite.suite).toBe("Test Suite")
		expect(suite.base_url).toBe("https://example.com")
		expect(suite.viewport).toEqual({ width: 1024, height: 768 })
		expect(suite.tests).toHaveLength(2)
	})

	it("expands reusable steps", async () => {
		const suite = await loadSuite(fixture("valid-suite.yaml"))
		const firstTest = suite.tests[0]
		// "log in" should be expanded to its 3 constituent steps
		expect(firstTest.steps).toHaveLength(4)
		expect(firstTest.steps[0]).toContain("enter")
		expect(firstTest.steps[1]).toContain("Password")
		expect(firstTest.steps[2]).toBe('click "Sign In"')
	})

	it("interpolates suite variables in expanded steps", async () => {
		const suite = await loadSuite(fixture("valid-suite.yaml"))
		const firstTest = suite.tests[0]
		// {{username}} should be resolved to "alice"
		expect(firstTest.steps[0]).toBe('enter "alice" into "Username"')
	})

	it("loads a minimal suite without optional fields", async () => {
		const suite = await loadSuite(fixture("minimal-suite.yaml"))
		expect(suite.suite).toBe("Minimal")
		expect(suite.viewport).toBeUndefined()
		expect(suite.variables).toBeUndefined()
		expect(suite.reusable_steps).toBeUndefined()
		expect(suite.tests).toHaveLength(1)
	})

	it("leaves non-reusable steps unchanged", async () => {
		const suite = await loadSuite(fixture("valid-suite.yaml"))
		const secondTest = suite.tests[1]
		expect(secondTest.steps[0]).toBe('go to "/about"')
	})

	it("rejects a suite with no tests", async () => {
		await expect(
			loadSuite(fixture("invalid-no-tests.yaml")),
		).rejects.toThrow()
	})

	it("rejects a suite with invalid URL", async () => {
		await expect(
			loadSuite(fixture("invalid-bad-url.yaml")),
		).rejects.toThrow()
	})

	it("throws on nonexistent file", async () => {
		await expect(loadSuite(fixture("does-not-exist.yaml"))).rejects.toThrow()
	})

	it("resolves env variables in steps", async () => {
		vi.stubEnv("TEST_PASSWORD", "s3cret")
		const suite = await loadSuite(fixture("env-suite.yaml"))
		expect(suite.tests[0].steps[0]).toBe('enter "s3cret" into "Password"')
	})
})
