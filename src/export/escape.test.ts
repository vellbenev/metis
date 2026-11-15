import { MarkdownManager } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { describe, expect, it } from 'vitest';
import type { JSONNode } from '../core/blocks';
import { loadFixture } from '../test/fixtures';
import { AI_CLOSE, AI_OPEN, docToMarkdown } from './markdown';

const text = (t: string, ...marks: JSONNode[]): JSONNode => (marks.length ? { type: 'text', text: t, marks } : { type: 'text', text: t });
const para = (...content: JSONNode[]): JSONNode => ({ type: 'paragraph', content });
const doc = (...content: JSONNode[]): JSONNode => ({ type: 'doc', content });
const md = (s: string) => docToMarkdown(doc(para(text(s))));

/** A stock importer, to check the escaped Markdown reads back as the same plain text. */
const importer = new MarkdownManager({ extensions: [StarterKit] });
function reimport(markdown: string): JSONNode {
	return importer.parse(markdown) as JSONNode;
}
/** Reads back as one paragraph whose plain text equals `s` (no headings, lists, emphasis, links or code). */
function roundTrips(s: string) {
	const back = reimport(md(s));
	expect(back.content, JSON.stringify(back)).toHaveLength(1);
	const p = back.content![0];
	expect(p.type).toBe('paragraph');
	for (const n of p.content ?? []) expect(n.marks ?? [], JSON.stringify(n)).toEqual([]);
	expect((p.content ?? []).map(n => n.text).join('')).toBe(s);
}

const lines = loadFixture('persian/export-markdown-chars.txt')
	.split('\n')
	.filter(l => l.length > 0);

describe('ordinary text is not escaped', () => {
	it('the fixture has the characters that used to be escaped', () => {
		const all = lines.join('\n');
		for (const s of ['my_var_name', 'x_1', 'a*b', '<T>', 'a & b', 'x < y', '[۱]', '\\', '`', '~', '\u200c']) {
			expect(all).toContain(s);
		}
	});

	for (const l of lines) {
		it(`unchanged: ${l}`, () => {
			expect(md(l)).toBe(`${l}\n`);
			roundTrips(l);
		});
	}

	it('the whole fixture as one note comes out line for line', () => {
		const out = docToMarkdown(doc(...lines.map(l => para(text(l)))));
		expect(out).toBe(`${lines.join('\n\n')}\n`);
	});

	it('inside bold and next to provenance marks too', () => {
		const out = docToMarkdown(doc(para(text('my_var_name', { type: 'bold' }), text(' a & b', { type: 'rewrite' }, { type: 'gap' }))));
		expect(out).toBe('**my_var_name** a & b\n');
	});
});

describe('text that would become Markdown syntax is escaped (and reads back unchanged)', () => {
	const cases: [string, string][] = [
		['*کج* است', '\\*کج\\* است'],
		['_کج_ است', '\\_کج\\_ است'],
		['__init__ متد', '\\_\\_init\\_\\_ متد'],
		['2*3*4', '2\\*3\\*4'],
		['`code` اینجا', '\\`code\\` اینجا'],
		['~~خط~~', '\\~\\~خط\\~\\~'],
		['[متن](آدرس)', '\\[متن\\](آدرس)'],
		['&amp; و &#1604;', '\\&amp; و \\&#1604;'],
		['a\\*b', 'a\\\\\\*b'],
	];
	for (const [input, output] of cases) {
		it(input, () => {
			expect(md(input)).toBe(`${output}\n`);
			roundTrips(input);
		});
	}
});

describe('block starts', () => {
	const cases: [string, string][] = [
		['# عنوان نیست', '\\# عنوان نیست'],
		['## دو', '\\## دو'],
		['1. فهرست نیست', '1\\. فهرست نیست'],
		['12) فهرست نیست', '12\\) فهرست نیست'],
		['- فهرست نیست', '\\- فهرست نیست'],
		['+ فهرست نیست', '\\+ فهرست نیست'],
		['> نقل نیست', '\\> نقل نیست'],
		['---', '\\---'],
		['```js', '\\```js'],
	];
	for (const [input, output] of cases) {
		it(input, () => {
			expect(md(input)).toBe(`${output}\n`);
			roundTrips(input);
		});
	}

	it('the same characters later in a line are left alone', () => {
		for (const s of ['گام 1. و 2.', 'a - b و c + d', 'C# و F#', 'x > y']) expect(md(s)).toBe(`${s}\n`);
	});

	it('also after a hard break, and inside list items', () => {
		const d = doc(
			para(text('خط اول'), { type: 'hardBreak' }, text('# دوم')),
			{ type: 'bulletList', content: [{ type: 'listItem', content: [para(text('- تو در تو'))] }] },
		);
		expect(docToMarkdown(d)).toBe('خط اول  \n\\# دوم\n\n- \\- تو در تو\n');
	});

	it('a heading keeps a trailing # run as text', () => {
		const h = { type: 'heading', attrs: { level: 2 }, content: [text('زبان C #')] };
		expect(docToMarkdown(doc(h))).toBe('## زبان C \\#\n');
		expect(reimport('## زبان C \\#\n').content![0].content![0].text).toBe('زبان C #');
	});
});

describe('ai-added marker collision', () => {
	it('a literal marker in note text cannot pass for a real one', () => {
		const s = `${AI_OPEN}جعلی${AI_CLOSE}`;
		const out = md(s);
		expect(out).toBe(`\\${AI_OPEN}جعلی\\${AI_CLOSE}\n`);
		expect(out.split(AI_OPEN).length - 1).toBe(1); // only as part of the escaped text
		expect(out).not.toMatch(/(^|[^\\])<!-- ai-added -->/);
		roundTrips(s);
	});

	it('real markers stay unescaped next to escaped fake ones', () => {
		const out = docToMarkdown(doc(para(text('<!-- x -->'), text('واقعی', { type: 'aiAdded', attrs: { accepted: false } }))));
		expect(out).toBe(`\\<!-- x -->${AI_OPEN}واقعی${AI_CLOSE}\n`);
	});

	it('an intraword _ next to an ai-added boundary is escaped, since the comment ends the word', () => {
		const out = docToMarkdown(doc(para(text('a'), text('_b_', { type: 'aiAdded' }), text('c'))));
		expect(out).toBe(`a${AI_OPEN}\\_b\\_${AI_CLOSE}c\n`);
	});
});

describe('code is never escaped', () => {
	it('inline code and code blocks keep every character', () => {
		const d = doc(
			para(text('my_*var* <!-- & `', { type: 'code' })),
			{ type: 'codeBlock', attrs: { language: null }, content: [text('# a_b *c* <T> & [x](y)')] },
		);
		expect(docToMarkdown(d)).toBe('`` my_*var* <!-- & ` ``\n\n```\n# a_b *c* <T> & [x](y)\n```\n');
	});
});
