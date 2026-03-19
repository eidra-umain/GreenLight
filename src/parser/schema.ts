import { z } from "zod"

/** Viewport dimensions. */
export const ViewportSchema = z.object({
	width: z.number().int().positive(),
	height: z.number().int().positive(),
})

/** A block conditional step: if/then/else with multi-step branches. */
export const ConditionalStepSchema = z.object({
	if: z.string().min(1),
	then: z.array(z.string().min(1)).min(1),
	else: z.array(z.string().min(1)).optional(),
})

/** A step is either a plain string or a block conditional. */
export const StepSchema = z.union([
	z.string().min(1),
	ConditionalStepSchema,
])

/** A single test case: a name and ordered list of plain-English steps. */
export const TestCaseSchema = z.object({
	name: z.string().min(1),
	description: z.string().optional(),
	steps: z.array(StepSchema).min(1),
})

/**
 * Top-level suite definition — matches the YAML format from the spec.
 *
 * reusable_steps is a map of name → step list.
 * variables is a map of name → string value.
 */
export const SuiteSchema = z.object({
	suite: z.string().min(1),
	viewport: ViewportSchema.optional(),
	model: z
		.union([
			z.string().min(1),
			z.object({ planner: z.string().min(1), pilot: z.string().min(1) }),
		])
		.optional(),
	variables: z.record(z.string(), z.string()).optional(),
	reusable_steps: z.record(z.string(), z.array(z.string().min(1))).optional(),
	tests: z.array(TestCaseSchema).min(1),
})

/** Inferred TypeScript types from the schemas. */
export type Suite = z.infer<typeof SuiteSchema>
export type TestCase = z.infer<typeof TestCaseSchema>
export type ConditionalStep = z.infer<typeof ConditionalStepSchema>
export type Step = z.infer<typeof StepSchema>
export type Viewport = z.infer<typeof ViewportSchema>
