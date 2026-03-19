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
 * Reads and writes cached heuristic plans and the hash index
 * in the .greenlight/ directory.
 */

import { readFile, writeFile, mkdir, unlink } from "node:fs/promises"
import { join } from "node:path"
import type { HeuristicPlan } from "./plan-types.js"

const GREENLIGHT_DIR = ".greenlight"
const PLANS_DIR = ".greenlight/plans"
const PARTIAL_DIR = ".greenlight/partial"
const HASH_FILE = ".greenlight/hashes.json"

/** Load the hash index mapping test keys to their source hashes. */
export async function loadHashIndex(
	projectRoot: string,
): Promise<Record<string, string>> {
	try {
		const raw = await readFile(join(projectRoot, HASH_FILE), "utf-8")
		return JSON.parse(raw) as Record<string, string>
	} catch {
		return {}
	}
}

/** Save the hash index to disk. */
export async function saveHashIndex(
	projectRoot: string,
	index: Record<string, string>,
): Promise<void> {
	await mkdir(join(projectRoot, GREENLIGHT_DIR), { recursive: true })
	await writeFile(
		join(projectRoot, HASH_FILE),
		JSON.stringify(index, null, 2) + "\n",
	)
}

/** Load a cached plan for a specific test case. Returns null if not found. */
export async function loadPlan(
	projectRoot: string,
	suiteSlug: string,
	testSlug: string,
): Promise<HeuristicPlan | null> {
	try {
		const path = join(projectRoot, PLANS_DIR, suiteSlug, `${testSlug}.json`)
		const raw = await readFile(path, "utf-8")
		return JSON.parse(raw) as HeuristicPlan
	} catch {
		return null
	}
}

/** Save a heuristic plan to disk. Creates directories as needed. */
export async function savePlan(
	projectRoot: string,
	plan: HeuristicPlan,
): Promise<void> {
	const dir = join(projectRoot, PLANS_DIR, plan.suiteSlug)
	await mkdir(dir, { recursive: true })
	const path = join(dir, `${plan.testSlug}.json`)
	await writeFile(path, JSON.stringify(plan, null, 2) + "\n")
}

/** Delete a cached plan file. No-op if the file doesn't exist. */
export async function deletePlan(
	projectRoot: string,
	suiteSlug: string,
	testSlug: string,
): Promise<void> {
	try {
		const path = join(projectRoot, PLANS_DIR, suiteSlug, `${testSlug}.json`)
		await unlink(path)
	} catch {
		// File doesn't exist — that's fine
	}
}

/** Load a partial plan (from a previous failed pilot run). */
export async function loadPartialPlan(
	projectRoot: string,
	suiteSlug: string,
	testSlug: string,
): Promise<HeuristicPlan | null> {
	try {
		const path = join(projectRoot, PARTIAL_DIR, suiteSlug, `${testSlug}.json`)
		const raw = await readFile(path, "utf-8")
		return JSON.parse(raw) as HeuristicPlan
	} catch {
		return null
	}
}

/** Save a partial plan from a failed pilot run. */
export async function savePartialPlan(
	projectRoot: string,
	plan: HeuristicPlan,
): Promise<void> {
	const dir = join(projectRoot, PARTIAL_DIR, plan.suiteSlug)
	await mkdir(dir, { recursive: true })
	const path = join(dir, `${plan.testSlug}.json`)
	await writeFile(path, JSON.stringify(plan, null, 2) + "\n")
}

/** Delete a partial plan (after a full plan is generated). */
export async function deletePartialPlan(
	projectRoot: string,
	suiteSlug: string,
	testSlug: string,
): Promise<void> {
	try {
		const path = join(projectRoot, PARTIAL_DIR, suiteSlug, `${testSlug}.json`)
		await unlink(path)
	} catch { /* doesn't exist */ }
}

/**
 * Ensure .greenlight/ is in .gitignore.
 * Appends the entry if .gitignore exists but doesn't contain it.
 * No-op if .gitignore doesn't exist.
 */
export async function ensureGitignore(projectRoot: string): Promise<void> {
	const gitignorePath = join(projectRoot, ".gitignore")
	try {
		const content = await readFile(gitignorePath, "utf-8")
		if (!content.includes(".greenlight")) {
			const entry = "\n# GreenLight cached plans\n.greenlight/\n"
			await writeFile(gitignorePath, content + entry)
		}
	} catch {
		// No .gitignore — skip
	}
}
