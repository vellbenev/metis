import { describe, expect, it } from 'vitest';
import { loadFixture } from '../test/fixtures';
import { ProviderError } from './errors';
import { createMockProvider } from './mock';
import { TEST_LATIN_TERMS, TEST_PARAGRAPH, testModel } from './testModel';

const clock = (...times: number[]) => () => times.shift()!;

describe('Test model', () => {
	it('uses a fixed paragraph from the fixtures that contains Latin terms', () => {
		const fixture = loadFixture('persian/zkp-01-basics.txt');
		for (const line of TEST_PARAGRAPH.split('\n')) expect(fixture).toContain(line);
		expect(TEST_PARAGRAPH).toMatch(/[؀-ۿ]/);
		expect(TEST_LATIN_TERMS).toEqual(
			expect.arrayContaining(['prover', 'verifier', 'completeness', 'soundness', 'zero', 'knowledge']),
		);
	});

	it('sends the paragraph once, asking for JSON, and passes a faithful JSON reply', async () => {
		const mock = createMockProvider(JSON.stringify({ text: `بازنویسی: ${TEST_LATIN_TERMS.join(' ')}` }));
		const report = await testModel(mock, { now: clock(100, 1350) });
		expect(mock.callCount).toBe(1);
		expect(mock.calls[0].json).toBe(true);
		expect(mock.calls[0].messages.at(-1)).toEqual({ role: 'user', content: TEST_PARAGRAPH });
		expect(report).toMatchObject({ ok: true, nonEmpty: true, missingLatinTerms: [], json: 'valid', latencyMs: 1250 });
	});

	it('reports Latin terms that were translated away', async () => {
		const text = TEST_LATIN_TERMS.join(' ').replace('prover', 'اثبات‌کننده');
		const report = await testModel(createMockProvider(JSON.stringify({ text })));
		expect(report.ok).toBe(false);
		expect(report.missingLatinTerms).toEqual(['prover']);
	});

	it('matches Latin terms case-insensitively', async () => {
		const report = await testModel(createMockProvider(JSON.stringify({ text: TEST_LATIN_TERMS.join(' ').toUpperCase() })));
		expect(report.missingLatinTerms).toEqual([]);
	});

	it('flags invalid JSON when JSON was requested', async () => {
		for (const reply of [TEST_LATIN_TERMS.join(' '), '```json\n{}\n```', '[1]', 'null']) {
			const report = await testModel(createMockProvider(reply));
			expect(report.json, reply).toBe('invalid');
			expect(report.ok).toBe(false);
		}
	});

	it('skips the JSON check when JSON was not requested', async () => {
		const mock = createMockProvider(TEST_LATIN_TERMS.join(' '));
		const report = await testModel(mock, { json: false });
		expect(mock.calls[0].json).toBe(false);
		expect(report).toMatchObject({ ok: true, json: 'not-requested' });
	});

	it('flags an empty reply', async () => {
		for (const reply of ['   ', JSON.stringify({ text: '' })]) {
			const report = await testModel(createMockProvider(reply), { json: reply.startsWith('{') });
			expect(report.nonEmpty).toBe(false);
			expect(report.ok).toBe(false);
		}
	});

	it('returns provider errors in the report instead of throwing', async () => {
		const mock = createMockProvider(() => {
			throw new ProviderError('auth', 'no');
		});
		const report = await testModel(mock, { now: clock(0, 40) });
		expect(report.ok).toBe(false);
		expect(report.error?.kind).toBe('auth');
		expect(report.latencyMs).toBe(40);
	});
});
