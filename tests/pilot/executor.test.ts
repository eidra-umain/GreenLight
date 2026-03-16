import { describe, it, expect } from "vitest"
import type { Page } from "playwright"
import {
	launchBrowser,
	createContext,
	createPage,
	closeBrowser,
} from "../../src/browser/browser.js"
import { executeAction } from "../../src/pilot/executor.js"
import { findNodeByRef, findNodePath } from "../../src/pilot/locator.js"
import type { A11yNode, Action } from "../../src/reporter/types.js"
import { DEFAULTS } from "../../src/types.js"

const sampleTree: A11yNode[] = [
	{
		ref: "_navigation",
		role: "navigation",
		name: "Nav",
		raw: "- navigation",
		children: [
			{ ref: "e1", role: "link", name: "Home", raw: '- link "Home"' },
			{ ref: "e2", role: "link", name: "About", raw: '- link "About"' },
		],
	},
	{ ref: "e3", role: "textbox", name: "Email", raw: '- textbox "Email"' },
	{
		ref: "e4",
		role: "button",
		name: "Submit",
		raw: '- button "Submit"',
	},
]

describe("findNodeByRef", () => {
	it("finds a root-level node", () => {
		const node = findNodeByRef(sampleTree, "e3")
		expect(node?.role).toBe("textbox")
		expect(node?.name).toBe("Email")
	})

	it("finds a nested node", () => {
		const node = findNodeByRef(sampleTree, "e1")
		expect(node?.role).toBe("link")
		expect(node?.name).toBe("Home")
	})

	it("finds a non-interactive node", () => {
		const node = findNodeByRef(sampleTree, "_navigation")
		expect(node?.role).toBe("navigation")
	})

	it("returns undefined for missing ref", () => {
		expect(findNodeByRef(sampleTree, "e99")).toBeUndefined()
	})
})

describe("findNodePath", () => {
	it("returns path to a root-level node", () => {
		const path = findNodePath(sampleTree, "e3")
		expect(path).toHaveLength(1)
		expect(path?.[0].role).toBe("textbox")
	})

	it("returns path including ancestors for nested node", () => {
		const path = findNodePath(sampleTree, "e1")
		expect(path).toHaveLength(2)
		expect(path?.[0].role).toBe("navigation")
		expect(path?.[0].name).toBe("Nav")
		expect(path?.[1].role).toBe("link")
		expect(path?.[1].name).toBe("Home")
	})

	it("returns undefined for missing ref", () => {
		expect(findNodePath(sampleTree, "e99")).toBeUndefined()
	})
})

describe("executeAction with real browser", () => {
	const html = `
		<html><body>
			<h1>Test Page</h1>
			<input type="text" aria-label="Username" />
			<button onclick="document.getElementById('out').textContent='Clicked!'">Go</button>
			<p id="out"></p>
			<select aria-label="Color">
				<option value="r">Red</option>
				<option value="g">Green</option>
				<option value="b">Blue</option>
			</select>
			<a href="/about">About</a>
		</body></html>
	`

	const tree: A11yNode[] = [
		{
			ref: "e1",
			role: "heading",
			name: "Test Page",
			raw: '- heading "Test Page"',
		},
		{
			ref: "e2",
			role: "textbox",
			name: "Username",
			raw: '- textbox "Username"',
		},
		{ ref: "e3", role: "button", name: "Go", raw: '- button "Go"' },
		{
			ref: "e4",
			role: "combobox",
			name: "Color",
			raw: '- combobox "Color"',
		},
		{ ref: "e5", role: "link", name: "About", raw: '- link "About"' },
	]

	async function withPage(
		fn: (page: Page) => Promise<void>,
	) {
		const browser = await launchBrowser({
			headed: false,
			viewport: DEFAULTS.viewport,
		})
		const context = await createContext(browser, {
			headed: false,
			viewport: DEFAULTS.viewport,
		})
		const page = await createPage(context)
		await page.setContent(html)
		try {
			await fn(page)
		} finally {
			await context.close()
			await closeBrowser(browser)
		}
	}

	it("executes a click action", async () => {
		await withPage(async (page) => {
			const action: Action = { action: "click", ref: "e3" }
			const result = await executeAction(page, action, tree)
			expect(result.success).toBe(true)

			const text = await page.locator("#out").textContent()
			expect(text).toBe("Clicked!")
		})
	})

	it("executes a type action", async () => {
		await withPage(async (page) => {
			const action: Action = {
				action: "type",
				ref: "e2",
				value: "testuser",
			}
			const result = await executeAction(page, action, tree)
			expect(result.success).toBe(true)

			const value = await page
				.getByRole("textbox", { name: "Username" })
				.inputValue()
			expect(value).toBe("testuser")
		})
	})

	it("executes a select action", async () => {
		await withPage(async (page) => {
			const action: Action = {
				action: "select",
				ref: "e4",
				value: "Green",
			}
			const result = await executeAction(page, action, tree)
			expect(result.success).toBe(true)

			const value = await page
				.getByRole("combobox", { name: "Color" })
				.inputValue()
			expect(value).toBe("g")
		})
	})

	it("executes a scroll action", async () => {
		await withPage(async (page) => {
			const action: Action = { action: "scroll", value: "down" }
			const result = await executeAction(page, action, tree)
			expect(result.success).toBe(true)
		})
	})

	it("executes a navigate action", async () => {
		await withPage(async (page) => {
			const action: Action = {
				action: "navigate",
				value: "data:text/html,<h1>New</h1>",
			}
			const result = await executeAction(page, action, tree)
			expect(result.success).toBe(true)
			expect(page.url()).toContain("data:text/html")
		})
	})

	it("executes a contains_text assertion (pass)", async () => {
		await withPage(async (page) => {
			const action: Action = {
				action: "assert",
				assertion: { type: "contains_text", expected: "Test Page" },
			}
			const result = await executeAction(page, action, tree)
			expect(result.success).toBe(true)
		})
	})

	it("executes a contains_text assertion (fail)", { timeout: 10000 }, async () => {
		await withPage(async (page) => {
			const action: Action = {
				action: "assert",
				assertion: {
					type: "contains_text",
					expected: "Nonexistent Text",
				},
			}
			const result = await executeAction(page, action, tree)
			expect(result.success).toBe(false)
			expect(result.error).toContain("does not contain text")
		})
	})

	it("executes a url_contains assertion", async () => {
		await withPage(async (page) => {
			const action: Action = {
				action: "assert",
				assertion: { type: "url_contains", expected: "about:blank" },
			}
			// page.setContent navigates to about:blank
			const result = await executeAction(page, action, tree)
			expect(result.success).toBe(true)
		})
	})

	it("returns error for missing ref", async () => {
		await withPage(async (page) => {
			const action: Action = { action: "click", ref: "e99" }
			const result = await executeAction(page, action, tree)
			expect(result.success).toBe(false)
			expect(result.error).toContain("not found")
		})
	})

	it("returns error for click without ref", async () => {
		await withPage(async (page) => {
			const action: Action = { action: "click" }
			const result = await executeAction(page, action, tree)
			expect(result.success).toBe(false)
			expect(result.error).toContain("requires a ref")
		})
	})

	it("returns error for type without value", async () => {
		await withPage(async (page) => {
			const action: Action = { action: "type", ref: "e2" }
			const result = await executeAction(page, action, tree)
			expect(result.success).toBe(false)
			expect(result.error).toContain("requires a value")
		})
	})

	it("executes a relative navigate action", async () => {
		await withPage(async (page) => {
			await page.goto("data:text/html,<h1>Base</h1>")
			const action: Action = {
				action: "navigate",
				value: "data:text/html,<h1>Relative</h1>",
			}
			const result = await executeAction(page, action, tree)
			expect(result.success).toBe(true)
		})
	})
})
