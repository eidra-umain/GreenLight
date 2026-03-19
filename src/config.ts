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

/**
 * Load project-level configuration from greenlight.yaml.
 *
 * Supports multiple deployments. Each deployment can override any config field.
 * If only one deployment exists it is used automatically. Otherwise the file
 * must specify `default_deployment` or the user must pass `--deployment`.
 */

import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { parse as parseYaml } from "yaml"
import { z } from "zod"

/** Fields that can appear at the top level or inside a deployment. */
const ConfigFieldsSchema = z.object({
	base_url: z.string().optional(),
	model: z
		.union([
			z.string().min(1),
			z.object({ planner: z.string().min(1), pilot: z.string().min(1) }),
		])
		.optional(),
	provider: z.enum(["openrouter", "openai", "gemini", "claude"]).optional(),
	llm_base_url: z.string().optional(),
	timeout: z.number().int().positive().optional(),
	headed: z.boolean().optional(),
	parallel: z.number().int().positive().optional(),
	reporter: z.enum(["cli", "json", "html"]).optional(),
	viewport: z
		.object({
			width: z.number().int().positive(),
			height: z.number().int().positive(),
		})
		.optional(),
})

const ProjectConfigSchema = ConfigFieldsSchema.extend({
	suites: z.array(z.string().min(1)).min(1),
	deployments: z.record(z.string(), ConfigFieldsSchema).optional(),
	default_deployment: z.string().optional(),
})

type RawProjectConfig = z.infer<typeof ProjectConfigSchema>

/** The resolved config after selecting a deployment. */
export type ProjectConfig = z.infer<typeof ConfigFieldsSchema> & {
	suites: string[]
}

const CONFIG_FILE = "greenlight.yaml"

/**
 * Try to load greenlight.yaml from the current working directory.
 * Returns the parsed and deployment-resolved config, or undefined if the file doesn't exist.
 *
 * @param deploymentFlag - The --deployment CLI flag value, if provided.
 */
export async function loadProjectConfig(
	deploymentFlag?: string,
	cwd: string = process.cwd(),
): Promise<ProjectConfig | undefined> {
	const configPath = resolve(cwd, CONFIG_FILE)
	let raw: string
	try {
		raw = await readFile(configPath, "utf-8")
	} catch {
		return undefined
	}

	const data: unknown = parseYaml(raw)
	const parsed = ProjectConfigSchema.parse(data)

	return resolveDeployment(parsed, deploymentFlag)
}

/**
 * Select a deployment and merge its fields over the top-level config.
 */
function resolveDeployment(
	parsed: RawProjectConfig,
	deploymentFlag?: string,
): ProjectConfig {
	const { deployments, default_deployment, suites, ...topLevel } = parsed

	const deploymentNames = Object.keys(deployments ?? {})

	// No deployments section — use top-level config as-is
	if (deploymentNames.length === 0) {
		return { ...topLevel, suites }
	}

	// Determine which deployment to use
	let name: string
	if (deploymentFlag) {
		name = deploymentFlag
	} else if (deploymentNames.length === 1) {
		name = deploymentNames[0]
	} else if (default_deployment) {
		name = default_deployment
	} else {
		console.error(
			`Multiple deployments found (${deploymentNames.join(", ")}) but no default specified.\n` +
				`Set default_deployment in greenlight.yaml or pass --deployment <name>.`,
		)
		process.exit(1)
	}

	const deployment = deployments?.[name]
	if (!deployment) {
		console.error(
			`Deployment "${name}" not found. Available: ${deploymentNames.join(", ")}`,
		)
		process.exit(1)
	}

	// Merge: deployment fields override top-level fields
	return {
		...topLevel,
		...stripUndefined(deployment),
		suites,
	}
}

/** Remove keys with undefined values so they don't override top-level values during spread. */
function stripUndefined<T extends Record<string, unknown>>(obj: T): T {
	const result = {} as Record<string, unknown>
	for (const [key, value] of Object.entries(obj)) {
		if (value !== undefined) {
			result[key] = value
		}
	}
	return result as T
}
