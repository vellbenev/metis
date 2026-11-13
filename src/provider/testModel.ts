import fixture from '../../fixtures/persian/zkp-01-basics.txt?raw';
import { ProviderError } from './errors';
import type { ChatMessage, Provider } from './types';

/** Fixed Persian paragraph for the Test model button: two fixture lines rich in Latin terms. */
export const TEST_PARAGRAPH = (() => {
	const lines = fixture.split('\n').map(l => l.trim());
	return [lines[1], lines[4]].join('\n');
})();

/** Latin words in the paragraph; each must survive the model's reply. */
export const TEST_LATIN_TERMS = [...new Set(TEST_PARAGRAPH.match(/[A-Za-z][A-Za-z-]*/g) ?? [])];

export type JsonCheck = 'valid' | 'invalid' | 'not-requested';

export interface TestModelReport {
	ok: boolean;
	latencyMs: number;
	nonEmpty: boolean;
	missingLatinTerms: string[];
	json: JsonCheck;
	reply: string;
	error?: ProviderError;
}

export interface TestModelOptions {
	json?: boolean; // default true
	now?: () => number;
	signal?: AbortSignal;
}

export function testModelMessages(json: boolean): ChatMessage[] {
	const format = json
		? 'Reply with a JSON object of the form {"text": "<the rewritten note>"} and nothing else.'
		: 'Reply with the rewritten note only.';
	return [
		{
			role: 'system',
			content:
				'Rewrite the user\'s Persian note as clean, semi-formal written Persian. Keep every Latin technical term exactly as written, in Latin script; never translate or transliterate it. ' +
				format,
		},
		{ role: 'user', content: TEST_PARAGRAPH },
	];
}

/** Sends the fixed paragraph once and checks the reply. Never throws; failures land in `error`. */
export async function testModel(provider: Provider, options: TestModelOptions = {}): Promise<TestModelReport> {
	const json = options.json ?? true;
	const now = options.now ?? (() => performance.now());
	const start = now();
	let reply: string;
	try {
		({ content: reply } = await provider.complete({
			messages: testModelMessages(json),
			json,
			temperature: 0,
			signal: options.signal,
		}));
	} catch (err) {
		const error =
			err instanceof ProviderError ? err : new ProviderError('bad-response', err instanceof Error ? err.message : String(err));
		return {
			ok: false,
			latencyMs: now() - start,
			nonEmpty: false,
			missingLatinTerms: [],
			json: json ? 'invalid' : 'not-requested',
			reply: '',
			error,
		};
	}
	const latencyMs = now() - start;

	let text = reply;
	let jsonCheck: JsonCheck = 'not-requested';
	if (json) {
		jsonCheck = 'invalid';
		try {
			const parsed: unknown = JSON.parse(reply);
			if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
				jsonCheck = 'valid';
				const field = (parsed as { text?: unknown }).text;
				if (typeof field === 'string') text = field;
			}
		} catch {
			// stays invalid
		}
	}

	const nonEmpty = text.trim().length > 0;
	const lower = text.toLowerCase();
	const missingLatinTerms = TEST_LATIN_TERMS.filter(term => !lower.includes(term.toLowerCase()));
	return {
		ok: nonEmpty && missingLatinTerms.length === 0 && jsonCheck !== 'invalid',
		latencyMs,
		nonEmpty,
		missingLatinTerms,
		json: jsonCheck,
		reply,
	};
}
