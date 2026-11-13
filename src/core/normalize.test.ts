import { describe, expect, it } from 'vitest';
import { loadFixture } from '../test/fixtures';
import type { JSONNode } from './blocks';
import { normalizeNode, normalizePersian as n } from './normalize';

const Z = '‌';

describe('normalizePersian (I8)', () => {
	it('joins the verb prefixes می and نمی with ZWNJ', () => {
		expect(n('می رود')).toBe(`می${Z}رود`);
		expect(n('نمی رود')).toBe(`نمی${Z}رود`);
		expect(n('او هر روز می  رود')).toBe(`او هر روز می${Z}رود`);
		expect(n('ما نمی دانیم')).toBe(`ما نمی${Z}دانیم`);
	});

	it('does not treat می inside another word as a prefix', () => {
		expect(n('کمی رود')).toBe('کمی رود');
		expect(n('سیمی ساده')).toBe('سیمی ساده');
		expect(n('می rust')).toBe('می rust');
	});

	it('joins only the unambiguous suffixes ها, های, هایی, تر, ترین with ZWNJ', () => {
		expect(n('کتاب ها')).toBe(`کتاب${Z}ها`);
		expect(n('کتاب های من')).toBe(`کتاب${Z}های من`);
		expect(n('کتاب هایی که')).toBe(`کتاب${Z}هایی که`);
		expect(n('بزرگ تر')).toBe(`بزرگ${Z}تر`);
		expect(n('بزرگ ترین')).toBe(`بزرگ${Z}ترین`);
	});

	it('leaves ای, ام, ات, اش separate (they can be words of their own; the prompt handles them)', () => {
		expect(n('گفت ای خدا')).toBe('گفت ای خدا'); // vocative ای
		expect(n('خانه ای')).toBe('خانه ای');
		expect(n('خسته ام')).toBe('خسته ام');
		expect(n('خانه ات')).toBe('خانه ات');
		expect(n('خانه اش')).toBe('خانه اش');
	});

	it('does not join a word that only starts like a suffix', () => {
		expect(n('کتاب هاشمی')).toBe('کتاب هاشمی');
		expect(n('از ترس')).toBe('از ترس');
		expect(n('خانه امروز')).toBe('خانه امروز');
	});

	it('is idempotent on text that already has ZWNJ', () => {
		const text = `می${Z}رود و کتاب${Z}ها`;
		expect(n(text)).toBe(text);
		expect(n(n('نمی رود کتاب ها ، بزرگ تر'))).toBe(n('نمی رود کتاب ها ، بزرگ تر'));
	});

	it('maps Arabic ي and ك to Persian ی and ک', () => {
		expect(n('كتاب علي')).toBe('کتاب علی');
	});

	it('maps Arabic-Indic digits to Persian digits and leaves Latin digits alone', () => {
		expect(n('٠١٢٣٤٥٦٧٨٩')).toBe('۰۱۲۳۴۵۶۷۸۹');
		expect(n('سال 2024 و ۱۴۰۳')).toBe('سال 2024 و ۱۴۰۳');
	});

	it('removes tatweel', () => {
		expect(n('ســـلام')).toBe('سلام');
	});

	it('collapses repeated spaces in Persian text', () => {
		expect(n('سلام    دنیا')).toBe('سلام دنیا');
		expect(n('prover   اثبات')).toBe('prover اثبات');
	});

	it('normalises punctuation only in Persian runs', () => {
		expect(n('چیه?')).toBe('چیه؟');
		expect(n('اول, دوم; سوم')).toBe('اول، دوم؛ سوم');
		expect(n('داره ، درش')).toBe('داره، درش');
		expect(n('الف،ب')).toBe('الف، ب');
		expect(n('What is it?')).toBe('What is it?');
		expect(n('a, b; c')).toBe('a, b; c');
		expect(n('۱,۰۰۰')).toBe('۱,۰۰۰');
	});

	it('never modifies Latin text', () => {
		const latin = 'zk-SNARK  and   fiat-shamir, prover; verifier?  done';
		expect(n(latin)).toBe(latin);
		expect(n(`سلام ${latin}`)).toBe(`سلام ${latin}`);
	});

	it('never modifies URLs or backtick code spans', () => {
		expect(n('ببین https://example.org/a?b=ي,ك  ٠ اینجا')).toBe('ببین https://example.org/a?b=ي,ك ۰ اینجا');
		expect(n('کد `می رود  ي` اینجا')).toBe('کد `می رود  ي` اینجا');
	});

	it('is deterministic on a whole fixture', () => {
		const text = loadFixture('persian/zkp-01-basics.txt');
		expect(n(text)).toBe(n(text));
		expect(n(text)).toContain('اثبات کننده، verifier');
		for (const term of ['prover', 'verifier', 'ali baba cave', 'zero knowledge', 'fiat-shamir', 'non-interactive']) {
			expect(n(text)).toContain(term);
		}
	});
});

describe('normalizeNode', () => {
	it('normalises text nodes at any depth and returns a copy', () => {
		const block: JSONNode = {
			type: 'bulletList',
			attrs: { id: 'b1' },
			content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'كتاب ها' }] }] }],
		};
		const before = structuredClone(block);
		const out = normalizeNode(block);
		expect(block).toEqual(before);
		expect(out.content![0].content![0].content![0].text).toBe(`کتاب${Z}ها`);
		expect(out.attrs).toEqual({ id: 'b1' });
	});

	it('never touches code marks or code blocks', () => {
		const inline: JSONNode = {
			type: 'paragraph',
			content: [
				{ type: 'text', text: 'می رود' },
				{ type: 'text', text: 'می رود  ي', marks: [{ type: 'code' }] },
			],
		};
		const out = normalizeNode(inline);
		expect(out.content![0].text).toBe(`می${Z}رود`);
		expect(out.content![1].text).toBe('می رود  ي');
		const code: JSONNode = { type: 'codeBlock', content: [{ type: 'text', text: 'كتاب  ها ٠' }] };
		expect(normalizeNode(code)).toEqual(code);
	});
});
