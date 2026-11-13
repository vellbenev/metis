import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderError } from './errors';
import { chatCompletionsUrl, createOpenAIProvider, type FetchFn } from './openai';
import type { ProviderProfile } from './types';

const ollama: ProviderProfile = { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:8b' };
const router: ProviderProfile = { baseUrl: 'https://openrouter.example/api/v1', apiKey: 'sk-test', model: 'x/y' };
const messages = [{ role: 'user' as const, content: 'سلام prover' }];

function okResponse(content: unknown): Response {
	return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});
}

function spyFetch(respond: () => Response | Promise<Response> = () => okResponse('ok')) {
	return vi.fn<FetchFn>(async () => respond());
}

async function failure(promise: Promise<unknown>): Promise<ProviderError> {
	const err = await promise.then(
		() => undefined,
		e => e,
	);
	expect(err).toBeInstanceOf(ProviderError);
	return err as ProviderError;
}

describe('request shape', () => {
	it('POSTs to {baseUrl}/chat/completions with model, messages and stream: false', async () => {
		const fetch = spyFetch();
		await createOpenAIProvider(ollama, { fetch }).complete({ messages });
		expect(fetch).toHaveBeenCalledTimes(1);
		const [url, init] = fetch.mock.calls[0];
		expect(url).toBe('http://localhost:11434/v1/chat/completions');
		expect(init.method).toBe('POST');
		expect(JSON.parse(init.body as string)).toEqual({ model: 'qwen3:8b', messages, stream: false });
	});

	it('sends Content-Type always and Authorization only when an API key is set', async () => {
		const fetch = spyFetch();
		await createOpenAIProvider(ollama, { fetch }).complete({ messages });
		await createOpenAIProvider(router, { fetch }).complete({ messages });
		const [noKey, withKey] = fetch.mock.calls.map(c => c[1].headers as Record<string, string>);
		expect(noKey).toEqual({ 'Content-Type': 'application/json' });
		expect(withKey).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer sk-test' });
	});

	it('requests a JSON object and passes temperature when asked', async () => {
		const fetch = spyFetch();
		await createOpenAIProvider(ollama, { fetch }).complete({ messages, json: true, temperature: 0 });
		expect(JSON.parse(fetch.mock.calls[0][1].body as string)).toMatchObject({
			response_format: { type: 'json_object' },
			temperature: 0,
		});
	});

	it('joins baseUrl and path without doubling slashes', () => {
		expect(chatCompletionsUrl('http://localhost:11434/v1/')).toBe('http://localhost:11434/v1/chat/completions');
		expect(chatCompletionsUrl(' https://openrouter.example/api/v1// ')).toBe(
			'https://openrouter.example/api/v1/chat/completions',
		);
	});

	it('returns the first choice content', async () => {
		const fetch = spyFetch(() => okResponse('پاسخ با zk-SNARK'));
		expect(await createOpenAIProvider(ollama, { fetch }).complete({ messages })).toEqual({
			content: 'پاسخ با zk-SNARK',
		});
	});
});

describe('error mapping', () => {
	const cases: [number, ProviderError['kind']][] = [
		[401, 'auth'],
		[403, 'auth'],
		[404, 'not-found'],
		[429, 'rate-limit'],
		[500, 'server'],
		[503, 'server'],
		[400, 'http'],
	];
	it.each(cases)('HTTP %i -> %s, with the server message', async (status, kind) => {
		const fetch = spyFetch(() => new Response(JSON.stringify({ error: { message: 'boom' } }), { status }));
		const err = await failure(createOpenAIProvider(router, { fetch }).complete({ messages }));
		expect(err.kind).toBe(kind);
		expect(err.status).toBe(status);
		expect(err.message).toContain('boom');
	});

	it('a non-JSON 2xx body is a bad response', async () => {
		const fetch = spyFetch(() => new Response('<html>', { status: 200 }));
		expect((await failure(createOpenAIProvider(router, { fetch }).complete({ messages }))).kind).toBe(
			'bad-response',
		);
	});

	it('a 2xx without choices[0].message.content is a bad response', async () => {
		for (const body of [{}, { choices: [] }, { choices: [{ message: { content: null } }] }]) {
			const fetch = spyFetch(() => new Response(JSON.stringify(body), { status: 200 }));
			expect((await failure(createOpenAIProvider(router, { fetch }).complete({ messages }))).kind).toBe(
				'bad-response',
			);
		}
	});

	it('a network failure against local Ollama looks like CORS and carries the OLLAMA_ORIGINS hint', async () => {
		const fetch = vi.fn<FetchFn>(async () => {
			throw new TypeError('Failed to fetch');
		});
		const origin = 'http://localhost:5173';
		for (const baseUrl of ['http://localhost:11434/v1', 'http://127.0.0.1:11434/v1', 'http://box.lan:11434/v1']) {
			const err = await failure(createOpenAIProvider({ ...ollama, baseUrl }, { fetch, origin }).complete({ messages }));
			expect(err.kind).toBe('cors-local');
			expect(err.message).toContain(`OLLAMA_ORIGINS=${origin}`);
		}
	});

	it('a network failure against a remote API is a plain network error without the hint', async () => {
		const fetch = vi.fn<FetchFn>(async () => {
			throw new TypeError('Failed to fetch');
		});
		const err = await failure(createOpenAIProvider(router, { fetch }).complete({ messages }));
		expect(err.kind).toBe('network');
		expect(err.message).not.toContain('OLLAMA_ORIGINS');
	});

	it('an aborted request maps to aborted', async () => {
		const fetch = vi.fn<FetchFn>(async () => {
			throw new DOMException('aborted', 'AbortError');
		});
		expect((await failure(createOpenAIProvider(ollama, { fetch }).complete({ messages }))).kind).toBe('aborted');
	});
});

describe('network discipline (I6)', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('with the global fetch, every request goes to the configured baseUrl and nowhere else', async () => {
		const fetch = vi.fn(async (_url: string, _init?: RequestInit) => okResponse('ok'));
		vi.stubGlobal('fetch', fetch);
		const profiles = [ollama, router, { ...router, baseUrl: 'https://openrouter.example/api/v1/' }];
		for (const profile of profiles) {
			const provider = createOpenAIProvider(profile);
			await provider.complete({ messages });
			await provider.complete({ messages, json: true });
		}
		expect(fetch).toHaveBeenCalledTimes(profiles.length * 2);
		fetch.mock.calls.forEach(([url], i) => {
			const base = profiles[Math.floor(i / 2)].baseUrl.replace(/\/+$/, '');
			expect(String(url).startsWith(base + '/')).toBe(true);
		});
	});

	it('creating a client sends nothing', () => {
		const fetch = vi.fn();
		vi.stubGlobal('fetch', fetch);
		createOpenAIProvider(ollama);
		createOpenAIProvider(router);
		expect(fetch).not.toHaveBeenCalled();
	});
});
