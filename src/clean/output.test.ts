import { describe, expect, it } from 'vitest';
import { parseCleanOutput } from './output';

const ids = ['a'];
const p = (content: unknown, enrichment: 'off' | 'flag-gaps' | 'light-add' = 'flag-gaps') =>
	parseCleanOutput(typeof content === 'string' ? content : JSON.stringify(content), ids, enrichment);
const block = (extra: Record<string, unknown>) => ({ type: 'paragraph', text: 'متن', sources: ['a'], ...extra });

describe('parseCleanOutput', () => {
	it('accepts {blocks: [...]}, a bare array, and a fenced reply', () => {
		expect(p({ blocks: [block({})] }).ok).toBe(true);
		expect(p([block({})]).ok).toBe(true);
		expect(p('```json\n' + JSON.stringify({ blocks: [block({})] }) + '\n```').ok).toBe(true);
	});

	it('rejects bad JSON, a wrong shape and empty output', () => {
		expect(p('nope')).toEqual({ ok: false, error: 'not valid JSON' });
		expect(p({ items: [] }).ok).toBe(false);
		expect(p({ blocks: [] })).toEqual({ ok: false, error: 'no blocks' });
		expect(p({ blocks: [block({ text: '   ' })] }).ok).toBe(false);
		expect(p({ blocks: [block({ type: 'bulletList', text: undefined, items: [] })] }).ok).toBe(false);
	});

	it('rejects source ids outside the batch and missing sources', () => {
		expect(p({ blocks: [block({ sources: ['zzz'] })] }).ok).toBe(false);
		expect(p({ blocks: [block({ sources: [] })] }).ok).toBe(false);
		expect(p({ blocks: [block({ sources: undefined })] }).ok).toBe(false);
	});

	it('rejects output that leaves a batch block out of every sources list', () => {
		const twoIds = (content: unknown) => parseCleanOutput(JSON.stringify(content), ['a', 'b'], 'flag-gaps');
		expect(twoIds({ blocks: [block({})] })).toEqual({ ok: false, error: 'no output block has source "b"' });
		expect(twoIds({ blocks: [block({ sources: ['a', 'b'] })] }).ok).toBe(true);
	});

	it('rejects unknown types, bad heading levels and unbalanced tags', () => {
		expect(p({ blocks: [block({ type: 'table' })] }).ok).toBe(false);
		expect(p({ blocks: [block({ type: 'heading', level: 5 })] }).ok).toBe(false);
		expect(p({ blocks: [block({ text: 'الف <gap>ب' })] }).ok).toBe(false);
		expect(p({ blocks: [block({ text: 'الف <gap><ai>ب</ai></gap>' })] }, 'light-add').ok).toBe(false);
	});

	it('reads simple Markdown into marks, across <gap> tags, and keeps unmatched * literally', () => {
		const spans = (text: string, code: string[] = []) => {
			const r = parseCleanOutput(JSON.stringify({ blocks: [block({ text })] }), ids, 'flag-gaps', code);
			if (!r.ok) throw new Error(r.error);
			const b = r.blocks[0];
			return ('text' in b ? b.text : []).map(s => [s.text, ...(['bold', 'italic', 'code', 'gap'] as const).filter(k => s[k])]);
		};
		expect(spans('***الف*** ب')).toEqual([['الف', 'bold', 'italic'], [' ب']]);
		expect(spans('**الف <gap>ب</gap> ج**')).toEqual([['الف ', 'bold'], ['ب', 'bold', 'gap'], [' ج', 'bold']]);
		expect(spans('2 * 3 = 6')).toEqual([['2 * 3 = 6']]);
		expect(spans('a\\*b\\\\c')).toEqual([['a*b\\c']]);
		expect(spans('کد `` a`b `` و ` x `', ['a`b', 'x'])).toEqual([['کد '], ['a`b', 'code'], [' و '], ['x', 'code']]);
	});

	it('reads only an unmatched * literally; the other markers still format (Q29)', () => {
		const spans = (text: string) => {
			const r = parseCleanOutput(JSON.stringify({ blocks: [block({ text })] }), ids, 'flag-gaps');
			if (!r.ok) throw new Error(r.error);
			const b = r.blocks[0];
			return ('text' in b ? b.text : []).map(s => [s.text, ...(['bold', 'italic'] as const).filter(k => s[k])]);
		};
		expect(spans('**prover** و a*b')).toEqual([['prover', 'bold'], [' و a*b']]);
		expect(spans('a*b و **prover**')).toEqual([['a*b و '], ['prover', 'bold']]);
		expect(spans('**الف** *ب* و ج*')).toEqual([['الف', 'bold'], [' '], ['ب', 'italic'], [' و ج*']]);
		expect(spans('**الف** و **ب')).toEqual([['الف', 'bold'], [' و **ب']]);
		expect(spans('a*b *ج*')).toEqual([['a*b '], ['ج', 'italic']]);
		expect(spans('x * y و *ب*')).toEqual([['x * y و '], ['ب', 'italic']]);
	});

	it('requires every Latin term of the input; case, hyphen and Persian suffix variants pass', () => {
		const withTerms = (text: string, terms = ['zk-SNARK', 'prover']) =>
			parseCleanOutput(JSON.stringify({ blocks: [block({ text })] }), ids, 'flag-gaps', [], terms);
		expect(withTerms('zk-SNARK و prover').ok).toBe(true);
		expect(withTerms('اثبات‌کننده و zk-SNARK')).toEqual({ ok: false, error: 'Latin terms must be kept as written: prover' });
		expect(withTerms('zk-SNARK و پروور').ok).toBe(false);
		// A longer Latin word is not the term.
		expect(withTerms('zk-SNARKs و prover').ok).toBe(false);
		expect(withTerms('zk-SNARK و provers').ok).toBe(false);
		// Variants of valid output that must not be rejected.
		expect(withTerms('**zk-SNARK** و *prover*').ok).toBe(true);
		expect(withTerms('**zk**-SNARK و prover').ok).toBe(true);
		expect(withTerms('ZK-SNARK و Prover').ok).toBe(true);
		expect(withTerms('zk‑SNARK و prover').ok).toBe(true);
		expect(withTerms('zk-SNARK‌ها و prover‌ها').ok).toBe(true);
		expect(withTerms('zk-SNARKها، proverی.').ok).toBe(true);
		expect(withTerms('(zk-SNARK) و «prover»').ok).toBe(true);
		expect(withTerms('`zk-SNARK` و <gap>prover</gap>').ok).toBe(true);
		const list = parseCleanOutput(
			JSON.stringify({ blocks: [{ type: 'bulletList', items: ['zk-SNARK', 'prover'], sources: ['a'] }] }),
			ids,
			'flag-gaps',
			[],
			['zk-SNARK', 'prover'],
		);
		expect(list.ok).toBe(true);
	});

	it('requires every input code span exactly; invented code spans become plain text', () => {
		const withCode = (text: string) => parseCleanOutput(JSON.stringify({ blocks: [block({ text })] }), ids, 'flag-gaps', ['f(x)']);
		expect(withCode('ببین `f(x)`').ok).toBe(true);
		expect(withCode('ببین `f( x )`')).toEqual({ ok: false, error: 'inline code must be copied exactly: "f(x)"' });
		expect(withCode('ببین f(x)').ok).toBe(false);
		const r = withCode('ببین `f(x)` و `g`');
		expect(r.ok && r.blocks[0].type === 'paragraph' && r.blocks[0].text.map(s => s.code)).toEqual([false, true, false, false]);
	});

	it('allows <ai> only with light-add, and never a block made only of added text', () => {
		expect(p({ blocks: [block({ text: 'الف <ai>ب</ai>' })] }, 'off').ok).toBe(false);
		expect(p({ blocks: [block({ text: 'الف <ai>ب</ai>' })] }, 'light-add').ok).toBe(true);
		expect(p({ blocks: [block({ text: '<ai>همه‌اش افزوده</ai>' })] }, 'light-add').ok).toBe(false);
	});
});
