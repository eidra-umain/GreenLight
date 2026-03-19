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

import { type ChatMessage, type LLMProvider, type ProviderConfig, LLMApiError } from "./types.js"

/**
 * Native Anthropic Messages API provider.
 */
export function createAnthropicProvider(baseUrl: string): LLMProvider {
	const endpoint = `${baseUrl.replace(/\/+$/, "")}/v1/messages`

	return {
		async chatCompletion(
			messages: ChatMessage[],
			config: ProviderConfig,
		): Promise<string> {
			// Extract system message into separate field
			const systemMessages = messages.filter((m) => m.role === "system")
			const nonSystemMessages = messages.filter(
				(m) => m.role !== "system",
			)
			const systemText = systemMessages
				.map((m) => m.content)
				.join("\n\n")

			const response = await fetch(endpoint, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-api-key": config.apiKey,
					"anthropic-version": "2023-06-01",
				},
				body: JSON.stringify({
					model: config.model,
					max_tokens: 4096,
					temperature: 0,
					...(systemText ? { system: systemText } : {}),
					messages: nonSystemMessages.map((m) => ({
						role: m.role,
						content: m.content,
					})),
				}),
			})

			if (!response.ok) {
				const body = await response.text()
				throw new LLMApiError(response.status, body)
			}

			const data = (await response.json()) as {
				content: { type: string; text: string }[]
			}

			const content = data.content[0]?.text
			if (!content) {
				throw new Error("LLM returned empty response")
			}

			return content
		},
	}
}
