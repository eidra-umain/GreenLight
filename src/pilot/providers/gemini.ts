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

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com"

/**
 * Native Google Gemini API provider.
 */
export function createGeminiProvider(baseUrlOverride?: string): LLMProvider {
	return {
		async chatCompletion(
			messages: ChatMessage[],
			config: ProviderConfig,
		): Promise<string> {
			const baseUrl = (baseUrlOverride ?? DEFAULT_BASE_URL).replace(
				/\/+$/,
				"",
			)
			const endpoint = `${baseUrl}/v1beta/models/${config.model}:generateContent?key=${config.apiKey}`

			// Separate system messages from conversation messages
			const systemMessages = messages.filter((m) => m.role === "system")
			const conversationMessages = messages.filter(
				(m) => m.role !== "system",
			)

			// Build system instruction
			const systemInstruction =
				systemMessages.length > 0
					? {
							parts: systemMessages.map((m) => ({
								text: m.content,
							})),
						}
					: undefined

			// Map messages to Gemini format (assistant → model)
			const contents = conversationMessages.map((m) => ({
				role: m.role === "assistant" ? "model" : m.role,
				parts: [{ text: m.content }],
			}))

			const body: Record<string, unknown> = {
				contents,
				generationConfig: {
					temperature: 0,
				},
			}

			if (systemInstruction) {
				body.systemInstruction = systemInstruction
			}

			const response = await fetch(endpoint, {
				method: "POST",
				headers: {
					"content-type": "application/json",
				},
				body: JSON.stringify(body),
			})

			if (!response.ok) {
				const respBody = await response.text()
				throw new LLMApiError(response.status, respBody)
			}

			const data = (await response.json()) as {
				candidates: {
					content: { parts: { text: string }[] }
				}[]
			}

			const content = data.candidates[0]?.content?.parts[0]?.text
			if (!content) {
				throw new Error("LLM returned empty response")
			}

			return content
		},
	}
}
