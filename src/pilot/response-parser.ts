/**
 * Parsing and validation for LLM responses.
 */

import type { Action } from "../reporter/types.js"
import type { Condition } from "./conditions.js"

/** A single planned step: the display label and either a pre-resolved action or null. */
export interface PlannedStep {
	step: string
	action: Action | null
	/** If true, this step needs runtime expansion into multiple sub-actions (e.g. form filling). */
	needsExpansion?: boolean
	/** If true, this step triggers map detection and attachment. */
	needsMapDetect?: boolean
	/** For REMEMBER steps: the variable name to store the captured value under. */
	rememberAs?: string
	/** For COMPARE steps: the comparison metadata (variable + operator, or literal). Resolved at runtime. */
	compare?: { variable: string; operator: string; literal?: string }
	/** For conditional steps: the condition to evaluate at runtime. */
	condition?: Condition
	/** For conditional steps: the step(s) to execute if condition is true. */
	thenBranch?: PlannedStep[]
	/** For conditional steps: the step(s) to execute if condition is false (optional). */
	elseBranch?: PlannedStep[]
}

/** Parse a JSON string from the LLM into a validated Action. */
export function parseActionResponse(raw: string): Action {
	// Strip markdown code fences if the LLM wraps in ```json
	let cleaned = raw.trim()
	if (cleaned.startsWith("```")) {
		cleaned = cleaned.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "")
	}

	let parsed: unknown
	try {
		parsed = JSON.parse(cleaned)
	} catch {
		throw new Error(`LLM returned invalid JSON: ${raw}`)
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`LLM returned non-object JSON: ${raw}`)
	}

	const obj = parsed as Record<string, unknown>

	if (typeof obj.action !== "string" || obj.action.length === 0) {
		throw new Error(`LLM response missing "action" field: ${raw}`)
	}

	const VALID_ACTIONS = [
		"click",
		"check",
		"uncheck",
		"type",
		"select",
		"autocomplete",
		"scroll",
		"navigate",
		"press",
		"wait",
		"assert",
		"remember",
	]

	if (!VALID_ACTIONS.includes(obj.action)) {
		throw new Error(
			`LLM returned unknown action "${obj.action}". Valid: ${VALID_ACTIONS.join(", ")}`,
		)
	}

	const action: Action = { action: obj.action }

	if (typeof obj.ref === "string") {
		action.ref = obj.ref
	}
	if (typeof obj.text === "string") {
		action.text = obj.text
	}
	if (typeof obj.value === "string") {
		action.value = obj.value
	}
	if (typeof obj.option === "string") {
		action.option = obj.option
	}
	if (typeof obj.rememberAs === "string") {
		action.rememberAs = obj.rememberAs
	}
	if (typeof obj.compare === "object" && obj.compare !== null) {
		const c = obj.compare as Record<string, unknown>
		if (typeof c.variable === "string" && typeof c.operator === "string") {
			action.compare = {
				variable: c.variable,
				operator: c.operator as Action["compare"] extends { operator: infer O } ? O : never,
				...(typeof c.literal === "string" ? { literal: c.literal } : {}),
			}
		}
	}
	if (typeof obj.assertion === "object" && obj.assertion !== null) {
		const a = obj.assertion as Record<string, unknown>
		if (typeof a.type === "string" && typeof a.expected === "string") {
			action.assertion = { type: a.type, expected: a.expected }
		}
	}

	return action
}

/**
 * Parse a single action token from the plan response line format.
 * Returns the action (or null for PAGE) and an optional description.
 */
function parsePlanAction(token: string): {
	action: Action | null
	description?: string
	needsExpansion?: boolean
	needsMapDetect?: boolean
	rememberAs?: string
	compare?: { variable: string; operator: string; literal?: string }
	condition?: Condition
	thenBranch?: PlannedStep[]
	elseBranch?: PlannedStep[]
} {
	const t = token.trim()

	// IF_VISIBLE / IF_CONTAINS / IF_URL — conditional steps
	const conditionalMatch = /^IF_(VISIBLE|CONTAINS|URL)\s+"([^"]+)"\s+THEN\s+(.+?)(?:\s+ELSE\s+(.+))?$/i.exec(t)
	if (conditionalMatch) {
		const condType = conditionalMatch[1].toLowerCase() as "visible" | "contains" | "url"
		const condTarget = conditionalMatch[2]
		const thenToken = conditionalMatch[3].trim()
		const elseToken = conditionalMatch[4]?.trim()

		const thenParsed = parsePlanAction(thenToken)
		const thenStep: PlannedStep = {
			step: thenParsed.description ?? thenToken,
			action: thenParsed.action,
			...(thenParsed.needsExpansion ? { needsExpansion: true } : {}),
			...(thenParsed.needsMapDetect ? { needsMapDetect: true } : {}),
			...(thenParsed.rememberAs ? { rememberAs: thenParsed.rememberAs } : {}),
			...(thenParsed.compare ? { compare: thenParsed.compare } : {}),
		}

		let elseBranch: PlannedStep[] | undefined
		if (elseToken) {
			const elseParsed = parsePlanAction(elseToken)
			elseBranch = [{
				step: elseParsed.description ?? elseToken,
				action: elseParsed.action,
				...(elseParsed.needsExpansion ? { needsExpansion: true } : {}),
				...(elseParsed.needsMapDetect ? { needsMapDetect: true } : {}),
				...(elseParsed.rememberAs ? { rememberAs: elseParsed.rememberAs } : {}),
				...(elseParsed.compare ? { compare: elseParsed.compare } : {}),
			}]
		}

		return {
			action: null,
			description: t,
			condition: { type: condType, target: condTarget },
			thenBranch: [thenStep],
			elseBranch,
		}
	}

	// REMEMBER "description" as "variable_name"
	const rememberMatch = /^remember\s+"([^"]+)"\s+as\s+"([^"]+)"$/i.exec(t)
	if (rememberMatch) {
		return {
			action: null,
			description: rememberMatch[1],
			rememberAs: rememberMatch[2],
		}
	}

	// COMPARE "description" "operator" remembered "variable_name"
	// Returns action: null so it goes through resolveStep at runtime
	// (needs the live page to find the element containing the current value).
	// The compare metadata is stored on the PlannedStep for the pilot to use.
	const compareMatch = /^compare\s+"([^"]+)"\s+"([^"]+)"\s+remembered\s+"([^"]+)"$/i.exec(t)
	if (compareMatch) {
		return {
			action: null,
			description: compareMatch[1],
			compare: {
				variable: compareMatch[3],
				operator: compareMatch[2],
			},
		}
	}

	// COMPARE_VALUE — two forms:
	// 1. Explicit: COMPARE_VALUE "description" "operator" "literal"
	// 2. Simple:   COMPARE_VALUE "full step text"  (operator + literal extracted from text)
	const compareValueExplicit = /^compare_value\s+"([^"]+)"\s+"([^"]+)"\s+"([^"]*)"$/i.exec(t)
	if (compareValueExplicit) {
		return {
			action: null,
			description: compareValueExplicit[1],
			compare: {
				variable: "_",
				operator: compareValueExplicit[2],
				literal: compareValueExplicit[3],
			},
		}
	}
	const compareValueSimple = /^compare_value\s+"([^"]+)"$/i.exec(t)
	if (compareValueSimple) {
		const parsed = extractComparisonFromText(compareValueSimple[1])
		if (parsed) {
			return {
				action: null,
				description: compareValueSimple[1],
				compare: {
					variable: "_",
					operator: parsed.operator,
					literal: parsed.literal,
				},
			}
		}
		// Could not parse — fall through to PAGE-like handling
		return { action: null, description: compareValueSimple[1] }
	}

	// MAP_DETECT — detect and attach to a map instance
	if (/^map_detect$/i.test(t)) {
		return { action: null, description: "Detect map instance", needsMapDetect: true }
	}

	// EXPAND "description" — compound step needing runtime expansion
	if (/^expand(?:\s|$)/i.test(t)) {
		const after = t.slice(6).trim()
		const description = after.replace(/^"(.*)"$/, "$1") || undefined
		return { action: null, description, needsExpansion: true }
	}

	// PAGE "description", PAGE description, or bare PAGE
	if (/^page(?:\s|$)/i.test(t)) {
		const after = t.slice(4).trim()
		// Strip surrounding quotes if present
		const description = after.replace(/^"(.*)"$/, "$1") || undefined
		return { action: null, description }
	}

	// assert <type> "<expected>"
	const assertMatch = /^assert\s+(\S+)\s+"([^"]*)"$/i.exec(t)
	if (assertMatch) {
		// assert numeric "..." → extract comparison from text, treat like COMPARE_VALUE
		if (assertMatch[1].toLowerCase() === "numeric") {
			const parsed = extractComparisonFromText(assertMatch[2])
			if (parsed) {
				return {
					action: null,
					description: assertMatch[2],
					compare: {
						variable: "_",
						operator: parsed.operator,
						literal: parsed.literal,
					},
				}
			}
			// Could not parse — fall through to PAGE-like handling
			return { action: null, description: assertMatch[2] }
		}
		return {
			action: {
				action: "assert",
				assertion: { type: assertMatch[1], expected: assertMatch[2] },
			},
		}
	}

	// navigate "<url>"
	const navMatch = /^navigate\s+"([^"]*)"$/i.exec(t)
	if (navMatch) {
		return { action: { action: "navigate", value: navMatch[1] } }
	}

	// press "<key>"
	const pressMatch = /^press\s+"([^"]*)"$/i.exec(t)
	if (pressMatch) {
		return { action: { action: "press", value: pressMatch[1] } }
	}

	// scroll "<direction>"
	const scrollMatch = /^scroll\s+"([^"]*)"$/i.exec(t)
	if (scrollMatch) {
		return { action: { action: "scroll", value: scrollMatch[1].toLowerCase() } }
	}

	// Unknown token — treat as page-dependent
	return { action: null }
}

/**
 * Parse the planning LLM response (line-based format) into a flat list of PlannedSteps.
 * One line per action — compound input steps produce multiple lines.
 */
export function parsePlanResponse(raw: string): PlannedStep[] {
	return raw
		.trim()
		.split("\n")
		.filter((l) => l.trim().length > 0)
		.map((line) => {
			const { action, description, needsExpansion, needsMapDetect, rememberAs, compare, condition, thenBranch, elseBranch } = parsePlanAction(line)
			const step = description ?? line.trim()
			return {
				step,
				action,
				...(needsExpansion ? { needsExpansion: true } : {}),
				...(needsMapDetect ? { needsMapDetect: true } : {}),
				...(rememberAs ? { rememberAs } : {}),
				...(compare ? { compare } : {}),
				...(condition ? { condition } : {}),
				...(thenBranch ? { thenBranch } : {}),
				...(elseBranch ? { elseBranch } : {}),
			}
		})
}

/** Operator patterns for extracting comparison info from natural language. */
const COMPARISON_PATTERNS: { pattern: RegExp; operator: string }[] = [
	{ pattern: /greater\s+than\s+or\s+equal\s+to\s+(-?\d+\.?\d*)/, operator: "greater_or_equal" },
	{ pattern: /less\s+than\s+or\s+equal\s+to\s+(-?\d+\.?\d*)/, operator: "less_or_equal" },
	{ pattern: /greater\s+than\s+(-?\d+\.?\d*)/, operator: "greater_than" },
	{ pattern: /more\s+than\s+(-?\d+\.?\d*)/, operator: "greater_than" },
	{ pattern: /less\s+than\s+(-?\d+\.?\d*)/, operator: "less_than" },
	{ pattern: /fewer\s+than\s+(-?\d+\.?\d*)/, operator: "less_than" },
	{ pattern: /at\s+least\s+(-?\d+\.?\d*)/, operator: "greater_or_equal" },
	{ pattern: /at\s+most\s+(-?\d+\.?\d*)/, operator: "less_or_equal" },
	{ pattern: /equal(?:s)?\s+(?:to\s+)?(-?\d+\.?\d*)/, operator: "equal" },
	{ pattern: /not\s+equal\s+(?:to\s+)?(-?\d+\.?\d*)/, operator: "not_equal" },
]

/**
 * Extract comparison operator and literal number from a natural language
 * step description (e.g. "the count of products is greater than 0").
 * Returns null if no pattern matches.
 */
export function extractComparisonFromText(
	text: string,
): { operator: string; literal: string } | null {
	const lower = text.toLowerCase()
	for (const { pattern, operator } of COMPARISON_PATTERNS) {
		const match = pattern.exec(lower)
		if (match) {
			return { operator, literal: match[1] }
		}
	}
	return null
}

/**
 * Validate that every COMPARE in the plan references a REMEMBER that
 * appears earlier. Returns an array of error messages (empty if valid).
 */
export function validatePlanReferences(plan: PlannedStep[]): string[] {
	const errors: string[] = []
	const remembered = new Set<string>()

	for (const step of plan) {
		if (step.rememberAs) {
			remembered.add(step.rememberAs)
		}
		const compare = step.compare ?? step.action?.compare
		if (compare && !("literal" in compare && compare.literal !== undefined)) {
			const varName = compare.variable
			if (!remembered.has(varName)) {
				errors.push(
					`COMPARE references "${varName}" but no REMEMBER "${varName}" appears before it`,
				)
			}
		}
	}

	return errors
}
