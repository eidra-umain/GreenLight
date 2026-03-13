import { describe, it, expect, beforeEach } from "vitest"
import {
	parseA11ySnapshot,
	formatA11yTree,
	resetRefCounter,
} from "../../src/pilot/state.js"

beforeEach(() => {
	resetRefCounter()
})

describe("parseA11ySnapshot", () => {
	it("parses a simple link", () => {
		const nodes = parseA11ySnapshot('- link "Home"')
		expect(nodes).toHaveLength(1)
		expect(nodes[0].role).toBe("link")
		expect(nodes[0].name).toBe("Home")
		expect(nodes[0].ref).toBe("e1")
	})

	it("parses a heading with level", () => {
		const nodes = parseA11ySnapshot('- heading "Welcome" [level=1]')
		expect(nodes[0].role).toBe("heading")
		expect(nodes[0].name).toBe("Welcome")
		expect(nodes[0].level).toBe(1)
		expect(nodes[0].ref).toBe("e1")
	})

	it("assigns sequential refs to interactive elements", () => {
		const raw = [
			'- link "First"',
			'- button "Second"',
			'- searchbox "Third"',
		].join("\n")
		const nodes = parseA11ySnapshot(raw)
		expect(nodes[0].ref).toBe("e1")
		expect(nodes[1].ref).toBe("e2")
		expect(nodes[2].ref).toBe("e3")
	})

	it("does not assign numeric refs to non-interactive roles", () => {
		const raw = [
			"- list",
			"  - listitem",
			'    - link "Click me"',
		].join("\n")
		const nodes = parseA11ySnapshot(raw)
		expect(nodes[0].ref).toBe("_list")
		expect(nodes[0].children?.[0].ref).toBe("_listitem")
		expect(nodes[0].children?.[0].children?.[0].ref).toBe("e1")
	})

	it("builds nested tree from indentation", () => {
		const raw = [
			"- navigation \"Site\"",
			'  - link "Home"',
			'  - link "About"',
		].join("\n")
		const nodes = parseA11ySnapshot(raw)
		expect(nodes).toHaveLength(1)
		expect(nodes[0].role).toBe("navigation")
		expect(nodes[0].children).toHaveLength(2)
		expect(nodes[0].children?.[0].name).toBe("Home")
		expect(nodes[0].children?.[1].name).toBe("About")
	})

	it("attaches /url metadata to parent node", () => {
		const raw = [
			'- link "Home"',
			"  - /url: https://example.com",
		].join("\n")
		const nodes = parseA11ySnapshot(raw)
		expect(nodes[0].url).toBe("https://example.com")
	})

	it("parses role without name", () => {
		const nodes = parseA11ySnapshot("- banner")
		expect(nodes).toHaveLength(1)
		expect(nodes[0].role).toBe("banner")
		expect(nodes[0].name).toBe("")
	})

	it("parses role with colon text", () => {
		const nodes = parseA11ySnapshot("- text: Hello world")
		expect(nodes[0].role).toBe("text")
		expect(nodes[0].name).toBe("Hello world")
	})

	it("handles empty input", () => {
		expect(parseA11ySnapshot("")).toEqual([])
	})

	it("handles multiple root nodes", () => {
		const raw = ["- banner", "- main", "- contentinfo"].join("\n")
		const nodes = parseA11ySnapshot(raw)
		expect(nodes).toHaveLength(3)
	})
})

describe("formatA11yTree", () => {
	it("formats interactive nodes with refs", () => {
		const nodes = parseA11ySnapshot('- button "Submit"')
		const output = formatA11yTree(nodes)
		expect(output).toBe('[e1] button "Submit"')
	})

	it("formats non-interactive nodes without refs", () => {
		const nodes = parseA11ySnapshot("- banner")
		const output = formatA11yTree(nodes)
		expect(output).toBe("banner")
	})

	it("indents children", () => {
		const raw = [
			"- navigation \"Nav\"",
			'  - link "Home"',
		].join("\n")
		const nodes = parseA11ySnapshot(raw)
		const output = formatA11yTree(nodes)
		expect(output).toContain("navigation")
		expect(output).toContain("  [e1] link \"Home\"")
	})

	it("includes URL when present", () => {
		const raw = [
			'- link "Home"',
			"  - /url: /index.html",
		].join("\n")
		const nodes = parseA11ySnapshot(raw)
		const output = formatA11yTree(nodes)
		expect(output).toContain("→ /index.html")
	})

	it("includes level for headings", () => {
		const nodes = parseA11ySnapshot('- heading "Title" [level=2]')
		const output = formatA11yTree(nodes)
		expect(output).toContain("[level=2]")
	})
})

describe("resetRefCounter", () => {
	it("resets refs back to e1", () => {
		parseA11ySnapshot('- button "A"')
		parseA11ySnapshot('- button "B"')
		// Without reset, next ref would be e3
		resetRefCounter()
		const nodes = parseA11ySnapshot('- button "C"')
		expect(nodes[0].ref).toBe("e1")
	})
})
