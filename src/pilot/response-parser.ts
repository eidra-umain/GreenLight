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
	/** If true, this step needs runtime date/time picker expansion. */
	needsDatePick?: boolean
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
	/** Index of the original test input step this planned step came from (set by pilot). */
	inputStepIndex?: number
}

const VALID_ACTIONS = new Set([
	"click", "check", "uncheck", "type", "select", "autocomplete",
	"scroll", "navigate", "press", "wait", "assert", "remember",
])

/**
 * Extract a named parameter value from a text action line.
 * Supports: key=value and key="quoted value with spaces"
 */
function extractParam(line: string, key: string): string | undefined {
	// key="quoted value"
	const quotedRe = new RegExp(`${key}="([^"]*)"`)
	const quotedMatch = quotedRe.exec(line)
	if (quotedMatch) return quotedMatch[1]
	// key=unquotedValue
	const bareRe = new RegExp(`${key}=(\\S+)`)
	const bareMatch = bareRe.exec(line)
	if (bareMatch) return bareMatch[1]
	return undefined
}

/**
 * Parse a text-format action line from the LLM into a validated Action.
 *
 * Format: ACTION [ref=REF] [text="TEXT"] [value="VALUE"] [option="OPTION"] [as="VAR"]
 * Assert:  assert TYPE "EXPECTED" [ref=REF] [variable="VAR" operator="OP"] [literal="N"]
 *
 * Also accepts JSON as a fallback for backward compatibility.
 */
export function parseActionResponse(raw: string): Action {
	let cleaned = raw.trim()
	// Strip markdown code fences
	if (cleaned.startsWith("```")) {
		cleaned = cleaned.replace(/^```(?:\w*)?\s*/, "").replace(/\s*```$/, "")
	}

	// Text format parsing
	const parts = cleaned.split(/\s+/)
	const actionType = parts[0]?.toLowerCase()

	if (!actionType || !VALID_ACTIONS.has(actionType)) {
		throw new Error(`LLM returned unknown action "${parts[0] ?? ""}": ${raw}`)
	}

	const action: Action = { action: actionType }

	if (actionType === "assert") {
		// assert TYPE "EXPECTED" [ref=REF] [variable="VAR" operator="OP"] [literal="N"]
		const assertType = parts[1]
		if (!assertType) throw new Error(`assert missing type: ${raw}`)

		// Extract the quoted expected value
		const quotedMatch = /"([^"]*)"/.exec(cleaned.slice(cleaned.indexOf(assertType) + assertType.length))
		const expected = quotedMatch?.[1] ?? ""

		action.assertion = { type: assertType, expected }

		// Extract compare fields if present
		const variable = extractParam(cleaned, "variable")
		const operator = extractParam(cleaned, "operator")
		if (variable && operator) {
			action.compare = {
				variable,
				operator: operator as Action["compare"] extends { operator: infer O } ? O : never,
			}
			const literal = extractParam(cleaned, "literal")
			if (literal) action.compare.literal = literal
		}

		// ref for compare assertions
		action.ref = extractParam(cleaned, "ref")
	} else if (actionType === "remember") {
		action.ref = extractParam(cleaned, "ref")
		action.text = extractParam(cleaned, "text")
		action.rememberAs = extractParam(cleaned, "as")
	} else {
		action.ref = extractParam(cleaned, "ref")
		action.text = extractParam(cleaned, "text")
		action.value = extractParam(cleaned, "value")
		action.option = extractParam(cleaned, "option")
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
	needsDatePick?: boolean
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

	// ASSERT_REMEMBERED "variable_name" — check that a remembered value is visible on the page
	const assertRememberedMatch = /^assert_remembered\s+"([^"]+)"$/i.exec(t)
	if (assertRememberedMatch) {
		return {
			action: {
				action: "assert",
				assertion: { type: "contains_remembered", expected: assertRememberedMatch[1] },
				compare: { variable: assertRememberedMatch[1], operator: "equal" as const },
			},
			description: `check that remembered "${assertRememberedMatch[1]}" is visible on the page`,
		}
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

	// DATEPICK "description" "time expression" — date/time picker
	if (/^datepick(?:\s|$)/i.test(t)) {
		const after = t.slice(8).trim()
		// Extract two quoted strings: description and time expression
		const twoQuoted = /^"([^"]+)"\s+"([^"]+)"$/.exec(after)
		if (twoQuoted) {
			// Store time expression in the step text with a separator
			// so resolveDatePick can extract it
			return {
				action: null,
				description: `${twoQuoted[1]}||${twoQuoted[2]}`,
				needsDatePick: true,
			}
		}
		// Fallback: single quoted string (time expression = full description)
		const description = after.replace(/^"(.*)"$/, "$1") || undefined
		return { action: null, description, needsDatePick: true }
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
			// Extract optional "#N " input step index prefix
			let trimmedLine = line.trim()
			let inputStepIndex: number | undefined
			const indexMatch = /^#(\d+)\s+/.exec(trimmedLine)
			if (indexMatch) {
				inputStepIndex = parseInt(indexMatch[1], 10) - 1 // convert 1-based to 0-based
				trimmedLine = trimmedLine.slice(indexMatch[0].length)
			}

			const { action, description, needsExpansion, needsDatePick, needsMapDetect, rememberAs, compare, condition, thenBranch, elseBranch } = parsePlanAction(trimmedLine)
			const step = description ?? trimmedLine
			return {
				step,
				action,
				...(needsExpansion ? { needsExpansion: true } : {}),
				...(needsDatePick ? { needsDatePick: true } : {}),
				...(needsMapDetect ? { needsMapDetect: true } : {}),
				...(rememberAs ? { rememberAs } : {}),
				...(compare ? { compare } : {}),
				...(condition ? { condition } : {}),
				...(thenBranch ? { thenBranch } : {}),
				...(elseBranch ? { elseBranch } : {}),
				...(inputStepIndex != null ? { inputStepIndex } : {}),
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
