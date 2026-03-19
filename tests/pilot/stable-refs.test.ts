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

import { describe, it, expect, beforeEach } from "vitest"
import {
	parseA11ySnapshot,
	formatA11yTree,
	resetRefCounter,
} from "../../src/pilot/a11y-parser.js"

beforeEach(() => {
	resetRefCounter()
})

describe("stable refs across captures", () => {
	const baseSnapshot = [
		'- button "Submit"',
		'- textbox "Email"',
		'- link "Home"',
	].join("\n")

	it("assigns the same refs for identical snapshots", () => {
		const first = parseA11ySnapshot(baseSnapshot)
		const tree1 = formatA11yTree(first)

		// Simulate second capture (no resetRefCounter — same test case)
		const second = parseA11ySnapshot(baseSnapshot)
		const tree2 = formatA11yTree(second)

		expect(tree1).toBe(tree2)
		expect(first[0].ref).toBe(second[0].ref)
		expect(first[1].ref).toBe(second[1].ref)
		expect(first[2].ref).toBe(second[2].ref)
	})

	it("keeps existing refs stable when new elements appear", () => {
		const first = parseA11ySnapshot(baseSnapshot)
		const submitRef = first[0].ref
		const emailRef = first[1].ref
		const homeRef = first[2].ref

		// Second capture: a new element appears at the start
		const newSnapshot = [
			'- heading "Welcome" [level=1]',
			'- button "Submit"',
			'- textbox "Email"',
			'- link "Home"',
		].join("\n")
		const second = parseA11ySnapshot(newSnapshot)

		// Original elements keep their refs
		expect(second[1].ref).toBe(submitRef)  // button "Submit"
		expect(second[2].ref).toBe(emailRef)   // textbox "Email"
		expect(second[3].ref).toBe(homeRef)    // link "Home"

		// New element gets a new ref
		expect(second[0].ref).not.toBe(submitRef)
		expect(second[0].ref).not.toBe(emailRef)
		expect(second[0].ref).not.toBe(homeRef)
	})

	it("keeps refs stable when elements are removed", () => {
		const first = parseA11ySnapshot(baseSnapshot)
		const emailRef = first[1].ref
		const homeRef = first[2].ref

		// Second capture: first element removed
		const reducedSnapshot = [
			'- textbox "Email"',
			'- link "Home"',
		].join("\n")
		const second = parseA11ySnapshot(reducedSnapshot)

		expect(second[0].ref).toBe(emailRef)
		expect(second[1].ref).toBe(homeRef)
	})

	it("distinguishes elements with the same role but different names", () => {
		const snapshot = [
			'- button "Save"',
			'- button "Cancel"',
		].join("\n")
		const nodes = parseA11ySnapshot(snapshot)
		expect(nodes[0].ref).not.toBe(nodes[1].ref)
	})

	it("distinguishes elements with the same role and name via sibling index", () => {
		const snapshot = [
			'- button "Submit"',
			'- button "Submit"',
		].join("\n")
		const first = parseA11ySnapshot(snapshot)
		expect(first[0].ref).not.toBe(first[1].ref)

		// Second capture — same structure, same refs
		const second = parseA11ySnapshot(snapshot)
		expect(second[0].ref).toBe(first[0].ref)
		expect(second[1].ref).toBe(first[1].ref)
	})

	it("resets refs between test cases", () => {
		const first = parseA11ySnapshot('- button "Go"')
		const ref1 = first[0].ref

		resetRefCounter()

		const second = parseA11ySnapshot('- button "Go"')
		// After reset, the same element gets the same ref (starts from scratch)
		// but since the map is cleared, it's re-assigned from e1
		expect(second[0].ref).toBe("e1")
		expect(ref1).toBe("e1")
	})

	it("handles nested elements with stable refs", () => {
		const snapshot = [
			'- navigation "Nav"',
			'  - link "Home"',
			'  - link "About"',
		].join("\n")
		const first = parseA11ySnapshot(snapshot)
		const homeRef = first[0].children![0].ref
		const aboutRef = first[0].children![1].ref

		// Add a new link in between
		const snapshot2 = [
			'- navigation "Nav"',
			'  - link "Home"',
			'  - link "Blog"',
			'  - link "About"',
		].join("\n")
		const second = parseA11ySnapshot(snapshot2)

		// Home and About keep their refs
		expect(second[0].children![0].ref).toBe(homeRef)
		expect(second[0].children![2].ref).toBe(aboutRef)
		// Blog gets a new ref
		expect(second[0].children![1].ref).not.toBe(homeRef)
		expect(second[0].children![1].ref).not.toBe(aboutRef)
	})
})
