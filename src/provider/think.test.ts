import { describe, expect, it, vi } from 'vitest';
import { createMemorySettingsStore, DEFAULT_SETTINGS } from '../settings/store';
import { textToDoc } from '../test/fixtures';
import { buildVaultTextbook } from '../ui/textbookAction';
import { cleanNote } from '../ui/cleanAction';
import { MemoryDir } from '../vault/dir';
import { createVault } from '../vault/store';
import { createOpenAIProvider, type FetchFn } from './openai';
import { TEST_LATIN_TERMS, testModel } from './testModel';
import { stripThinking } from './think';
import type { ChatRequest, ProviderProfile } from './types';

describe('stripThinking', () => {
	it('returns a reply without think tags unchanged', () => {
		expect(stripThinking('  {"a": 1}\n')).toBe('  {"a": 1}\n');
	});

	it('removes a multiline think block before the answer', () => {
		expect(stripThinking('<think>\nfirst\n{"no": 1}\n</think>\n\n{"a": 1}')).toBe('{"a": 1}');
	});

	it('removes several think blocks, wherever they are, case-insensitively', () => {
		expect(stripThinking('<think>a</think>{"a":<THINK>b\nc</Think> 1}<think></think>')).toBe('{"a": 1}');
	});

	it('drops everything up to a closing tag that has no opening tag', () => {
		expect(stripThinking('reasoning {"x": 0}\n</think>\n{"a": 1}')).toBe('{"a": 1}');
	});

	it('treats an unclosed think block as reasoning to the end, so the answer is empty and invalid', () => {
		expect(stripThinking('<think>\nthe answer could be {"a": 1}')).toBe('');
		expect(stripThinking('<think>a</think>{"a": 1}<think>cut off')).toBe('{"a": 1}');
	});
});

// ---- every caller of the OpenAI-compatible client gets stripped replies ------------------------

const profile: ProviderProfile = { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:8b' };

/** A server whose replies all start with a reasoning block. */
function thinkingServer(answer: (body: { messages: ChatRequest['messages'] }) => string) {
	return vi.fn<FetchFn>(async (_url, init) => {
		const content = `<think>\nLet me think about {"blocks": []}...\n</think>\n${answer(JSON.parse(init.body as string))}`;
		return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
	});
}

describe('think blocks through the provider client', () => {
	it('the client returns the answer without the reasoning', async () => {
		const fetch = thinkingServer(() => 'جواب');
		const reply = await createOpenAIProvider(profile, { fetch }).complete({ messages: [{ role: 'user', content: 'x' }] });
		expect(reply.content).toBe('جواب');
	});

	it('the Test model check parses the answer after a think block', async () => {
		const fetch = thinkingServer(() => JSON.stringify({ text: TEST_LATIN_TERMS.join(' ') }));
		const report = await testModel(createOpenAIProvider(profile, { fetch }));
		expect(report).toMatchObject({ ok: true, json: 'valid', missingLatinTerms: [] });
		expect(report.reply).not.toContain('think');
	});

	it('the Test model check fails on an unclosed think block', async () => {
		const fetch = vi.fn<FetchFn>(
			async () => new Response(JSON.stringify({ choices: [{ message: { content: '<think>prover verifier' } }] })),
		);
		const report = await testModel(createOpenAIProvider(profile, { fetch }));
		expect(report).toMatchObject({ ok: false, nonEmpty: false, json: 'invalid' });
	});

	it('the clean profile accepts a reply that starts with a think block', async () => {
		const vault = await createVault(new MemoryDir(), 'ZKP');
		await vault.createNote([], 'n');
		const note = await vault.loadNote(['n']);
		const doc = textToDoc('prover = اثبات کننده');
		doc.content![0].attrs = { id: 'p1' };
		await vault.saveNote(['n'], { ...note, doc });
		const fetch = thinkingServer(() => JSON.stringify({ blocks: [{ type: 'paragraph', text: 'prover یعنی اثبات‌کننده', sources: ['p1'] }] }));
		const settings = createMemorySettingsStore({ ...DEFAULT_SETTINGS, clean: profile });
		const report = await cleanNote(vault, ['n'], settings, p => createOpenAIProvider(p, { fetch }));
		expect(report).toMatchObject({ changed: true, failed: [], modelCalls: 1 });
		expect(JSON.stringify(await vault.derived.loadClean(note.fileId))).toContain('prover یعنی');
	});

	it('the textbook profile accepts replies that start with a think block', async () => {
		const vault = await createVault(new MemoryDir(), 'ZKP');
		await vault.derived.saveClean({
			version: 1,
			fileId: 'f1',
			revision: 1,
			doc: {
				type: 'doc',
				content: [
					{ type: 'paragraph', attrs: { id: 'c1', sources: ['r1'], changedIn: 1 }, content: [{ type: 'text', text: 'prover', marks: [{ type: 'rewrite' }] }] },
				],
			},
		});
		const fetch = thinkingServer(body =>
			body.messages[0].content.includes('outline (table of contents)')
				? JSON.stringify({ ops: [{ op: 'add', title: 'مقدمه', files: ['f1'] }] })
				: JSON.stringify({ blocks: [{ type: 'paragraph', text: 'prover' }], gaps: [] }),
		);
		const settings = createMemorySettingsStore({ ...DEFAULT_SETTINGS, textbook: profile });
		const report = await buildVaultTextbook(vault, settings, p => createOpenAIProvider(p, { fetch }));
		expect(report.failed).toEqual([]);
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(Object.keys((await vault.derived.loadTextbook())!.sections)).toHaveLength(1);
	});
});
