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
		// base_url was removed from suite schema — now only in greenlight.yaml
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

	it("accepts a suite with invalid URL (base_url removed from suite schema)", async () => {
		// base_url is no longer validated in suite YAML — it's in greenlight.yaml
		const suite = await loadSuite(fixture("invalid-bad-url.yaml"))
		expect(suite.suite).toBeDefined()
	})

	it("throws on nonexistent file", async () => {
		await expect(loadSuite(fixture("does-not-exist.yaml"))).rejects.toThrow()
	})

	it("resolves env variables in steps", async () => {
		vi.stubEnv("TEST_PASSWORD", "s3cret")
		const suite = await loadSuite(fixture("env-suite.yaml"))
		expect(suite.tests[0].steps[0]).toBe('enter "s3cret" into "Password"')
	})

	// ── Block conditionals ───────────────────────────────────────────

	it("flattens single-step block conditional to inline", async () => {
		const suite = await loadSuite(fixture("conditional-suite.yaml"))
		const steps = suite.tests[0].steps
		// { if: "popup visible", then: ["click Dismiss"] } → "if popup visible then click \"Dismiss\""
		const popupStep = steps.find((s) => s.includes("popup"))
		expect(popupStep).toBe('if popup visible then click "Dismiss"')
	})

	it("flattens single-step if/else to inline", async () => {
		const suite = await loadSuite(fixture("conditional-suite.yaml"))
		const steps = suite.tests[0].steps
		// { if: "login prompt visible", then: ["click Sign in"], else: ["check logged in"] }
		const loginStep = steps.find((s) => s.includes("login prompt"))
		expect(loginStep).toBe('if login prompt visible then click "Sign in" else check that user is logged in')
	})

	it("flattens multi-step then branch into multiple conditionals", async () => {
		const suite = await loadSuite(fixture("conditional-suite.yaml"))
		const steps = suite.tests[0].steps
		// { if: "cookie banner", then: ["click Accept all", "wait for banner"] }
		const cookieSteps = steps.filter((s) => s.includes("cookie banner"))
		expect(cookieSteps).toHaveLength(2)
		expect(cookieSteps[0]).toBe('if cookie banner is visible then click "Accept all"')
		expect(cookieSteps[1]).toBe("if cookie banner is visible then wait for banner to disappear")
	})

	it("preserves plain string steps alongside conditionals", async () => {
		const suite = await loadSuite(fixture("conditional-suite.yaml"))
		const steps = suite.tests[0].steps
		expect(steps[0]).toBe("navigate to /home")
		expect(steps.some((s) => s === "check that the page loaded")).toBe(true)
	})

	it("all steps are plain strings after loading", async () => {
		const suite = await loadSuite(fixture("conditional-suite.yaml"))
		for (const step of suite.tests[0].steps) {
			expect(typeof step).toBe("string")
		}
	})
})
