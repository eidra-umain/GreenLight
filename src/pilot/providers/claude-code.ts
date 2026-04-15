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

import { spawnSync } from "node:child_process"
import {
	type ChatMessage,
	type LLMProvider,
	type ProviderConfig,
	LLMApiError,
} from "./types.js"

/**
 * Provider that delegates to the local `claude` CLI subprocess.
 * Requires Claude Code to be installed and authenticated. No API key needed.
 */
export function createClaudeCodeProvider(): LLMProvider {
	return {
		async chatCompletion(
			messages: ChatMessage[],
			config: ProviderConfig,
		): Promise<string> {
			// Extract system message into separate field
			const systemMessages = messages.filter((m) => m.role === "system")
			const nonSystemMessages = messages.filter((m) => m.role !== "system")

			const systemText = systemMessages
				.map((m) => m.content)
				.join("\n\n")	

			const result = spawnSync(
				"claude",
				[
					"--model", config.model,
					"--system-prompt", systemText,
					"--output-format", "text",
					"-p", JSON.stringify(nonSystemMessages),
				],
				{
					encoding: "utf8",
					maxBuffer: 100 * 1024 * 1024,
					timeout: 120_000,
				},
			)

			if (result.error) {
				throw new Error(
					`claude CLI not found. Install and authenticate Claude Code: ${result.error.message}`,
				)
			}

			if (result.status !== 0) {
				throw new LLMApiError(
					result.status ?? 1,
					result.stderr || "claude exited with non-zero status",
				)
			}

			const content = result.stdout.trim()

			if (!content) {
				throw new Error("LLM returned empty response")
			}

			return content
		},
	}
}
