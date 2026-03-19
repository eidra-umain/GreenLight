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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { interpolate, interpolateSteps } from "../../src/parser/variables.js"

describe("interpolate", () => {
	it("replaces suite variables", () => {
		const result = interpolate('enter "{{user}}" into "Name"', {
			user: "Alice",
		})
		expect(result).toBe('enter "Alice" into "Name"')
	})

	it("replaces multiple variables in one string", () => {
		const result = interpolate("{{greeting}}, {{name}}!", {
			greeting: "Hello",
			name: "Bob",
		})
		expect(result).toBe("Hello, Bob!")
	})

	it("replaces {{timestamp}} with a numeric string", () => {
		const result = interpolate("user_{{timestamp}}", {})
		expect(result).toMatch(/^user_\d+$/)
	})

	it("returns string unchanged when no placeholders", () => {
		const result = interpolate("click the button", {})
		expect(result).toBe("click the button")
	})

	it("throws on unknown variable", () => {
		expect(() => interpolate("{{missing}}", {})).toThrow(
			'Unknown variable "{{missing}}"',
		)
	})

	it("throws on unknown variable and lists available ones", () => {
		expect(() => interpolate("{{missing}}", { a: "1", b: "2" })).toThrow(
			"Available: a, b",
		)
	})

	describe("env variables", () => {
		const originalEnv = process.env

		beforeEach(() => {
			vi.stubEnv("TEST_VAR", "from-env")
		})

		afterEach(() => {
			vi.unstubAllEnvs()
			process.env = originalEnv
		})

		it("resolves {{env.X}} from process.env", () => {
			const result = interpolate("{{env.TEST_VAR}}", {})
			expect(result).toBe("from-env")
		})

		it("throws when env var is not set", () => {
			expect(() => interpolate("{{env.NONEXISTENT_VAR}}", {})).toThrow(
				'Environment variable "NONEXISTENT_VAR" is not set',
			)
		})
	})
})

describe("interpolateSteps", () => {
	it("interpolates all steps in array", () => {
		const steps = [
			'enter "{{user}}" into "Email"',
			'enter "{{pass}}" into "Password"',
			'click "Sign In"',
		]
		const result = interpolateSteps(steps, {
			user: "alice@test.com",
			pass: "secret",
		})
		expect(result).toEqual([
			'enter "alice@test.com" into "Email"',
			'enter "secret" into "Password"',
			'click "Sign In"',
		])
	})

	it("does not mutate the original array", () => {
		const steps = ['enter "{{x}}" into "Field"']
		const original = [...steps]
		interpolateSteps(steps, { x: "val" })
		expect(steps).toEqual(original)
	})
})
