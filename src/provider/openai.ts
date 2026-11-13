import { errorFromFetchFailure, errorFromStatus, ProviderError } from './errors';
import type { ChatRequest, ChatResponse, Provider, ProviderProfile } from './types';

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface OpenAIClientOptions {
	/** Defaults to the global fetch. This module is the app's only network call site (I6). */
	fetch?: FetchFn;
	/** This app's origin, used in the OLLAMA_ORIGINS hint. */
	origin?: string;
}

export function chatCompletionsUrl(baseUrl: string): string {
	return `${baseUrl.trim().replace(/\/+$/, '')}/chat/completions`;
}

export function buildChatBody(profile: ProviderProfile, request: ChatRequest): Record<string, unknown> {
	const body: Record<string, unknown> = { model: profile.model, messages: request.messages, stream: false };
	if (request.temperature !== undefined) body.temperature = request.temperature;
	if (request.json) body.response_format = { type: 'json_object' };
	return body;
}

function defaultOrigin(): string {
	return typeof location === 'undefined' ? '' : location.origin;
}

/** One client for `POST {baseUrl}/chat/completions` (Ollama `/v1`, OpenRouter, any OpenAI-compatible API). */
export function createOpenAIProvider(profile: ProviderProfile, options: OpenAIClientOptions = {}): Provider {
	const fetchFn: FetchFn = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
	const url = chatCompletionsUrl(profile.baseUrl);

	return {
		async complete(request: ChatRequest): Promise<ChatResponse> {
			const headers: Record<string, string> = { 'Content-Type': 'application/json' };
			if (profile.apiKey) headers.Authorization = `Bearer ${profile.apiKey}`;

			let response: Response;
			try {
				response = await fetchFn(url, {
					method: 'POST',
					headers,
					body: JSON.stringify(buildChatBody(profile, request)),
					signal: request.signal,
				});
			} catch (err) {
				throw errorFromFetchFailure(err, profile.baseUrl, options.origin ?? defaultOrigin());
			}

			if (!response.ok) throw errorFromStatus(response.status, await errorDetail(response));

			let data: unknown;
			try {
				data = await response.json();
			} catch {
				throw new ProviderError('bad-response', 'پاسخ سرور JSON معتبر نیست', response.status);
			}
			const content = (data as { choices?: { message?: { content?: unknown } }[] } | null)?.choices?.[0]?.message
				?.content;
			if (typeof content !== 'string') {
				throw new ProviderError('bad-response', 'پاسخ سرور شکل chat completion ندارد', response.status);
			}
			return { content };
		},
	};
}

async function errorDetail(response: Response): Promise<string> {
	try {
		const text = await response.text();
		try {
			const parsed = JSON.parse(text) as { error?: { message?: unknown } | string };
			const message = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message;
			if (typeof message === 'string') return message.slice(0, 200);
		} catch {
			// not JSON; fall through to the raw text
		}
		return text.slice(0, 200);
	} catch {
		return '';
	}
}
