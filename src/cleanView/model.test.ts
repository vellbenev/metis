import { describe, expect, it } from 'vitest';
import type { JSONNode } from '../core/blocks';
import type { CleanNote } from '../vault/types';
import {
	acceptAiAdded,
	aiSpans,
	changedBlocks,
	collectGaps,
	highlightKey,
	linkedBlocks,
	linkMap,
	removeAiAdded,
	runsIn,
	visibleHighlights,
} from './model';

const REWRITE = { type: 'rewrite' };
const AI = { type: 'aiAdded', attrs: { accepted: false } };
const GAP = { type: 'gap' };
const t = (text: string, ...marks: JSONNode['marks'] & object): JSONNode => ({ type: 'text', text, marks: [...marks] });
const block = (
	id: string,
	sources: string[],
	changedIn: number,
	content: JSONNode[],
	type = 'paragraph',
): JSONNode => ({
	type,
	attrs: { id, sources, changedIn },
	content,
});

function note(): CleanNote {
	return {
		version: 1,
		fileId: 'f1',
		revision: 3,
		doc: {
			type: 'doc',
			content: [
				block('c1', ['r1'], 1, [t('اثبات ', REWRITE), t('zk-SNARK', REWRITE, { type: 'code' })]),
				// One clean block from two raw blocks (merge), changed in the last clean.
				block('c2', ['r2', 'r3'], 3, [
					t('اثبات ', REWRITE),
					t('کوتاه', AI),
					t(' و ', REWRITE),
					t('سریع', AI, { type: 'bold' }),
					t(' است', AI),
					t(' ولی ', REWRITE),
					t('چیزی', REWRITE, GAP),
					t('.', REWRITE),
				]),
				// One raw block split into two clean blocks.
				block('c3', ['r4'], 3, [t('اول ', REWRITE), t('نامعلوم', REWRITE, GAP)]),
				block(
					'c4',
					['r4'],
					2,
					[
						{
							type: 'listItem',
							content: [{ type: 'paragraph', content: [t('یک ', REWRITE), t('دو', AI)] }],
						},
						{
							type: 'listItem',
							content: [{ type: 'paragraph', content: [t('سه ', REWRITE), t('چهار', REWRITE, GAP)] }],
						},
					],
					'bulletList',
				),
			],
		},
	};
}

describe('block linking', () => {
	it('maps clean blocks to their sources and raw blocks to their clean blocks', () => {
		const map = linkMap(note());
		expect(map.cleanToRaw.get('c2')).toEqual(['r2', 'r3']);
		expect(map.rawToClean.get('r3')).toEqual(['c2']);
		expect(map.rawToClean.get('r4')).toEqual(['c3', 'c4']);
		expect(map.rawToClean.get('nope')).toBeUndefined();
	});

	it('selecting a raw block lights it and all its clean blocks', () => {
		expect(linkedBlocks(linkMap(note()), { side: 'raw', id: 'r4' })).toEqual({ raw: ['r4'], clean: ['c3', 'c4'] });
	});

	it('selecting a clean block lights its sources and the clean blocks sharing them', () => {
		const map = linkMap(note());
		expect(linkedBlocks(map, { side: 'clean', id: 'c2' })).toEqual({ raw: ['r2', 'r3'], clean: ['c2'] });
		expect(linkedBlocks(map, { side: 'clean', id: 'c4' })).toEqual({ raw: ['r4'], clean: ['c3', 'c4'] });
	});

	it('handles no selection, unknown ids and no clean twin', () => {
		expect(linkedBlocks(linkMap(note()), undefined)).toEqual({ raw: [], clean: [] });
		expect(linkedBlocks(linkMap(note()), { side: 'raw', id: 'x' })).toEqual({ raw: ['x'], clean: [] });
		expect(linkedBlocks(linkMap(undefined), { side: 'clean', id: 'c1' })).toEqual({ raw: [], clean: ['c1'] });
	});
});

describe('change highlights', () => {
	it('highlights blocks whose changedIn equals the revision', () => {
		expect(changedBlocks(note())).toEqual(['c2', 'c3']);
		expect(changedBlocks(undefined)).toEqual([]);
	});

	it('dismissal is keyed by file and revision, so the next clean highlights again', () => {
		const n = note();
		expect(visibleHighlights(n, new Set())).toEqual(['c2', 'c3']);
		const dismissed = new Set([highlightKey(n)]);
		expect(visibleHighlights(n, dismissed)).toEqual([]);
		const next = { ...n, revision: 4, doc: { ...n.doc, content: [block('c9', ['r9'], 4, [t('نو', REWRITE)])] } };
		expect(visibleHighlights(next, dismissed)).toEqual(['c9']);
		expect(visibleHighlights({ ...n, fileId: 'f2' }, dismissed)).toEqual(['c2', 'c3']);
	});

	it('follows the last clean, not the revision: accept/remove (a new revision) keeps highlights and dismissal', () => {
		const cleaned = { ...note(), lastClean: 3 };
		const accepted = { ...acceptAiAdded(cleaned, 'c2', 0)!, revision: 4 };
		expect(changedBlocks(accepted)).toEqual(['c2', 'c3']);
		expect(highlightKey(accepted)).toBe(highlightKey(cleaned));
		expect(visibleHighlights(accepted, new Set([highlightKey(cleaned)]))).toEqual([]);
		// The next clean sets lastClean to its own revision and highlights its own blocks.
		const next = { ...accepted, revision: 5, lastClean: 5, doc: { type: 'doc', content: [block('c9', ['r9'], 5, [t('نو', REWRITE)])] } };
		expect(visibleHighlights(next, new Set([highlightKey(cleaned)]))).toEqual(['c9']);
	});
});

describe('gap list', () => {
	it('collects every gap span in document order with its block, nested lists included', () => {
		expect(collectGaps(note())).toEqual([
			{ blockId: 'c2', index: 0, text: 'چیزی', reason: 'unclear' },
			{ blockId: 'c3', index: 0, text: 'نامعلوم', reason: 'unclear' },
			{ blockId: 'c4', index: 0, text: 'چهار', reason: 'unclear' },
		]);
		expect(collectGaps(undefined)).toEqual([]);
	});

	it('joins adjacent gap text nodes into one span', () => {
		const n = note();
		n.doc.content = [
			block('c1', ['r1'], 1, [t('الف', REWRITE, GAP), t('ب', REWRITE, GAP, { type: 'bold' }), t(' ج', REWRITE)]),
		];
		expect(collectGaps(n)).toEqual([{ blockId: 'c1', index: 0, text: 'الفب', reason: 'unclear' }]);
	});

	it('reads the gap reason; a gap mark without one is unclear; adjacent gaps of two reasons are two spans', () => {
		const MISSING = { type: 'gap', attrs: { reason: 'term-missing' } };
		const UNCLEAR = { type: 'gap', attrs: { reason: 'unclear' } };
		const n = note();
		n.doc.content = [
			block('c1', ['r1'], 1, [t('الف', REWRITE, MISSING), t('ب', REWRITE, MISSING), t('ج', REWRITE, GAP), t('د', REWRITE, UNCLEAR)]),
			block('c2', ['r2'], 1, [t('ه', REWRITE, MISSING), t(' و ', REWRITE), t('ی', REWRITE, MISSING)]),
		];
		expect(collectGaps(n)).toEqual([
			{ blockId: 'c1', index: 0, text: 'الفب', reason: 'term-missing' },
			{ blockId: 'c1', index: 1, text: 'جد', reason: 'unclear' },
			{ blockId: 'c2', index: 0, text: 'ه', reason: 'term-missing' },
			{ blockId: 'c2', index: 1, text: 'ی', reason: 'term-missing' },
		]);
	});
});

describe('aiAdded runs', () => {
	it('groups adjacent aiAdded text nodes (e.g. partly bold) into one span', () => {
		const n = note();
		expect(runsIn(n.doc.content![1], 'aiAdded').map(r => r.map(x => x.text).join(''))).toEqual([
			'کوتاه',
			'سریع است',
		]);
		expect(aiSpans(n)).toEqual([
			{ blockId: 'c2', index: 0, text: 'کوتاه', accepted: false },
			{ blockId: 'c2', index: 1, text: 'سریع است', accepted: false },
			{ blockId: 'c4', index: 0, text: 'دو', accepted: false },
		]);
	});

	it('accept marks only that span accepted and keeps its aiAdded provenance (I4)', () => {
		const before = note();
		const frozen = JSON.stringify(before);
		const after = acceptAiAdded(before, 'c2', 1)!;
		expect(JSON.stringify(before)).toBe(frozen); // pure
		expect(aiSpans(after).map(s => s.accepted)).toEqual([false, true, false]);
		const c2 = after.doc.content![1].content!;
		expect(c2[3].marks).toEqual([{ type: 'aiAdded', attrs: { accepted: true } }, { type: 'bold' }]);
		expect(c2[4].marks).toEqual([{ type: 'aiAdded', attrs: { accepted: true } }]);
		expect(c2.map(n => n.text).join('')).toBe(before.doc.content![1].content!.map(n => n.text).join(''));
	});

	it('remove deletes only that span text', () => {
		const before = note();
		const after = removeAiAdded(before, 'c2', 0)!;
		expect(after.doc.content![1].content!.map(n => n.text).join('')).toBe('اثبات و سریع است ولی چیزی.');
		const nested = removeAiAdded(before, 'c4', 0)!;
		expect(nested.doc.content![3].content![0].content![0].content!.map(n => n.text)).toEqual(['یک']);
		expect(nested.doc.content![3].content![1]).toEqual(before.doc.content![3].content![1]);
	});

	it('remove leaves no double space, no space before punctuation and none at the edges', () => {
		const one = (content: JSONNode[]) => ({ ...note(), doc: { type: 'doc', content: [block('c1', ['r1'], 3, content)] } });
		const text = (n: CleanNote | undefined) => n!.doc.content![0].content!.map(x => x.text).join('');
		expect(removeAiAdded(note(), 'c2', 1)!.doc.content![1].content!.map(x => x.text).join('')).toBe('اثبات کوتاه و ولی چیزی.');
		expect(text(removeAiAdded(one([t('الف ', REWRITE), t('ب', AI), t('.', REWRITE)]), 'c1', 0))).toBe('الف.');
		expect(text(removeAiAdded(one([t('ب', AI), t(' الف', REWRITE)]), 'c1', 0))).toBe('الف');
		expect(text(removeAiAdded(one([t('الف', REWRITE), t('ب', AI), t('ج', REWRITE)]), 'c1', 0))).toBe('الفج');
		// The space-only node left over is dropped, and the bold mark on the text after is kept.
		const bold = removeAiAdded(one([t('الف', REWRITE), t(' ', REWRITE), t('ب', AI), t(' ج', REWRITE, { type: 'bold' })]), 'c1', 0)!;
		expect(bold.doc.content![0].content).toEqual([t('الف', REWRITE), t(' ج', REWRITE, { type: 'bold' })]);
	});

	it('accept and remove keep ids, sources, changedIn, revision and every other block byte-identical', () => {
		const before = note();
		for (const after of [
			acceptAiAdded(before, 'c2', 0)!,
			removeAiAdded(before, 'c2', 1)!,
			removeAiAdded(before, 'c4', 0)!,
		]) {
			expect(after.revision).toBe(before.revision);
			expect(after.fileId).toBe(before.fileId);
			expect(after.doc.content!.map(b => b.attrs)).toEqual(before.doc.content!.map(b => b.attrs));
			const changed = after.doc.content!.filter(
				(b, i) => JSON.stringify(b) !== JSON.stringify(before.doc.content![i]),
			);
			expect(changed).toHaveLength(1);
		}
	});

	it('returns undefined for an unknown block or span', () => {
		expect(acceptAiAdded(note(), 'nope', 0)).toBeUndefined();
		expect(acceptAiAdded(note(), 'c1', 0)).toBeUndefined();
		expect(removeAiAdded(note(), 'c2', 2)).toBeUndefined();
	});
});
