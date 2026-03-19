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
 * OpenAI-compatible chat completions provider.
 * Works with OpenRouter, OpenAI, and any API that follows the same format.
 */
export function createOpenAICompatibleProvider(baseUrl: string): LLMProvider {
	const endpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions`

	return {
		async chatCompletion(
			messages: ChatMessage[],
			config: ProviderConfig,
		): Promise<string> {
			const response = await fetch(endpoint, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${config.apiKey}`,
				},
				body: JSON.stringify({
					model: config.model,
					messages,
					temperature: 0,
				}),
			})

			if (!response.ok) {
				const body = await response.text()
				throw new LLMApiError(response.status, body)
			}

			const data = (await response.json()) as {
				choices: { message: { content: string } }[]
			}

			const content = data.choices[0]?.message?.content
			if (!content) {
				throw new Error("LLM returned empty response")
			}

			return content
		},
	}
}
