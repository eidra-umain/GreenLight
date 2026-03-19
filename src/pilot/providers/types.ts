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

export interface ChatMessage {
	role: "system" | "user" | "assistant"
	content: string
}

/**
 * Thrown when the LLM API returns a 4xx or 5xx error.
 * The run loop should catch this and abort the entire test run
 * rather than continuing to the next step or test case.
 */
export class LLMApiError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message)
		this.name = "LLMApiError"
	}
}

export interface ProviderConfig {
	apiKey: string
	model: string
}

export interface LLMProvider {
	chatCompletion(
		messages: ChatMessage[],
		config: ProviderConfig,
	): Promise<string>
}
