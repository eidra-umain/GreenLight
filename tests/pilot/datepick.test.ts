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
import { resolveDatePick } from "../../src/pilot/datepick.js"
import type { A11yNode } from "../../src/reporter/types.js"

// ── Sectioned picker (MUI v7 style) ─────────────────────────────────

const muiTree: A11yNode[] = [
	{
		ref: "_dialog",
		role: "dialog",
		name: "",
		raw: "- dialog",
		children: [
			{
				ref: "_group_start",
				role: "group",
				name: "Start date and time",
				raw: '- group "Start date and time"',
				children: [
					{ ref: "e1", role: "spinbutton", name: "Day", raw: '- spinbutton "Day"' },
					{ ref: "e2", role: "spinbutton", name: "Month", raw: '- spinbutton "Month"' },
					{ ref: "e3", role: "spinbutton", name: "Year", raw: '- spinbutton "Year"' },
					{ ref: "e4", role: "spinbutton", name: "Hours", raw: '- spinbutton "Hours"' },
					{ ref: "e5", role: "spinbutton", name: "Minutes", raw: '- spinbutton "Minutes"' },
				],
			},
			{
				ref: "_group_end",
				role: "group",
				name: "End date and time",
				raw: '- group "End date and time"',
				children: [
					{ ref: "e6", role: "spinbutton", name: "Day", raw: '- spinbutton "Day"' },
					{ ref: "e7", role: "spinbutton", name: "Month", raw: '- spinbutton "Month"' },
					{ ref: "e8", role: "spinbutton", name: "Year", raw: '- spinbutton "Year"' },
					{ ref: "e9", role: "spinbutton", name: "Hours", raw: '- spinbutton "Hours"' },
					{ ref: "e10", role: "spinbutton", name: "Minutes", raw: '- spinbutton "Minutes"' },
				],
			},
		],
	},
]

describe("resolveDatePick — sectioned picker", () => {
	it("targets the start group for a start-time step", () => {
		const steps = resolveDatePick(
			"set the start time to tomorrow at 3pm||tomorrow at 3pm",
			muiTree,
		)
		expect(steps.length).toBe(5)
		// All refs should be from the start group (e1-e5)
		const refs = steps.map((s) => s.action?.ref)
		expect(refs).toEqual(["e1", "e2", "e3", "e4", "e5"])
	})

	it("targets the end group for an end-time step", () => {
		const steps = resolveDatePick(
			"set the end time to tomorrow at 5pm||tomorrow at 5pm",
			muiTree,
		)
		const refs = steps.map((s) => s.action?.ref)
		expect(refs).toEqual(["e6", "e7", "e8", "e9", "e10"])
	})

	it("defaults to first group when step text is ambiguous", () => {
		const steps = resolveDatePick(
			"set the date to tomorrow||tomorrow",
			muiTree,
		)
		const refs = steps.map((s) => s.action?.ref)
		expect(refs).toEqual(["e1", "e2", "e3", "e4", "e5"])
	})

	it("generates correct date values", () => {
		const steps = resolveDatePick(
			"set the start time to 2026-06-15 14:30||2026-06-15 14:30",
			muiTree,
		)
		const values = steps.map((s) => s.action?.value)
		expect(values).toEqual(["15", "06", "2026", "14", "30"])
	})

	it("pads day and month to 2 digits", () => {
		const steps = resolveDatePick(
			"set the start date to 2026-01-05||2026-01-05",
			muiTree,
		)
		const values = steps.map((s) => s.action?.value)
		expect(values?.[0]).toBe("05") // day
		expect(values?.[1]).toBe("01") // month
	})
})

describe("resolveDatePick — group hint from LLM", () => {
	it("uses groupHint to select the correct group", () => {
		const steps = resolveDatePick(
			"set the end time to 1 hour from now||1 hour from now",
			muiTree,
			"End date and time",
		)
		const refs = steps.map((s) => s.action?.ref)
		expect(refs).toEqual(["e6", "e7", "e8", "e9", "e10"])
	})

	it("fuzzy matches groupHint", () => {
		const steps = resolveDatePick(
			"set time||2026-06-15 14:30",
			muiTree,
			"End date",
		)
		const refs = steps.map((s) => s.action?.ref)
		expect(refs).toEqual(["e6", "e7", "e8", "e9", "e10"])
	})

	it("without groupHint, fuzzy matches description against group names", () => {
		const steps = resolveDatePick(
			"set the end time to 1 hour from now||1 hour from now",
			muiTree,
		)
		const refs = steps.map((s) => s.action?.ref)
		expect(refs).toEqual(["e6", "e7", "e8", "e9", "e10"])
	})
})

// ── Relative time expressions ────────────────────────────────────────

describe("resolveDatePick — relative time", () => {
	it("parses '10 minutes from now'", () => {
		const before = new Date()
		const steps = resolveDatePick(
			"set the start time to 10 minutes from now||10 minutes from now",
			muiTree,
		)
		const after = new Date()
		// The minutes value should be roughly now + 10
		const minuteValue = parseInt(steps[4].action?.value ?? "0", 10)
		const expectedMin = (before.getMinutes() + 10) % 60
		const expectedMax = (after.getMinutes() + 10) % 60
		// Allow 1 minute drift for test execution time
		expect(
			minuteValue === expectedMin || minuteValue === expectedMax ||
			minuteValue === (expectedMin + 1) % 60,
		).toBe(true)
	})

	it("parses 'tomorrow'", () => {
		const steps = resolveDatePick(
			"set the start date to tomorrow||tomorrow",
			muiTree,
		)
		const tomorrow = new Date()
		tomorrow.setDate(tomorrow.getDate() + 1)
		expect(steps[0].action?.value).toBe(String(tomorrow.getDate()).padStart(2, "0"))
	})

	it("throws on unparseable expressions", () => {
		expect(() =>
			resolveDatePick("set date to xyzzy||xyzzy", muiTree),
		).toThrow("Could not parse a date/time")
	})
})

// ── || separator handling ────────────────────────────────────────────

describe("resolveDatePick — separator handling", () => {
	it("uses description (before ||) for group matching", () => {
		const steps = resolveDatePick(
			"set the end time to some value||2026-06-15 14:30",
			muiTree,
		)
		// Should match "end" group
		const refs = steps.map((s) => s.action?.ref)
		expect(refs).toEqual(["e6", "e7", "e8", "e9", "e10"])
	})

	it("uses time expression (after ||) for date parsing", () => {
		const steps = resolveDatePick(
			"set the start time to something||2026-12-25 10:00",
			muiTree,
		)
		const values = steps.map((s) => s.action?.value)
		expect(values).toEqual(["25", "12", "2026", "10", "00"])
	})

	it("works without separator (full text used for both)", () => {
		const steps = resolveDatePick(
			"set the start date to 2026-03-19",
			muiTree,
		)
		expect(steps.length).toBe(5)
		expect(steps[0].action?.value).toBe("19")
	})
})

// ── Native date input ────────────────────────────────────────────────

const nativeTree: A11yNode[] = [
	{ ref: "e1", role: "textbox", name: "Start date", raw: '- textbox "Start date"' },
	{ ref: "e2", role: "textbox", name: "End date", raw: '- textbox "End date"' },
]

describe("resolveDatePick — native input", () => {
	it("generates a single type action for a native date input", () => {
		const steps = resolveDatePick(
			"set the start date to 2026-06-15||2026-06-15",
			nativeTree,
		)
		expect(steps.length).toBe(1)
		expect(steps[0].action?.ref).toBe("e1")
		expect(steps[0].action?.value).toBe("2026-06-15")
	})
})

// ── No picker found ──────────────────────────────────────────────────

describe("resolveDatePick — no picker", () => {
	it("throws when no date picker elements exist", () => {
		const tree: A11yNode[] = [
			{ ref: "e1", role: "button", name: "Submit", raw: '- button "Submit"' },
		]
		expect(() =>
			resolveDatePick("set the date to tomorrow||tomorrow", tree),
		).toThrow("Could not find a date/time picker")
	})
})
