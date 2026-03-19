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
 * Hashing and slug utilities for cached test plans.
 */

import { createHash } from "node:crypto"

/**
 * Compute a SHA-256 hash of a test case's effective definition.
 * The input should be the fully resolved test case (after variable
 * interpolation and reusable step expansion).
 */
export function computeTestHash(testCase: { steps: string[] }): string {
	const content = JSON.stringify(testCase.steps)
	return createHash("sha256").update(content).digest("hex")
}

/** Convert a name to a URL/filesystem-safe kebab-case slug. */
export function slugify(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
}
