import { describe, expect, it, vi } from 'vitest';
import { canonicalHash, type JSONNode } from '../core/blocks';
import { normalizePersian } from '../core/normalize';
import { loadFixture, textToDoc } from '../test/fixtures';
import { MemoryDir, type Dir } from '../vault/dir';
import { createVault } from '../vault/store';
import type { CleanNote, Textbook, TextbookOutline } from '../vault/types';
import {
	AI_CLOSE,
	AI_OPEN,
	docToMarkdown,
	exportCleanTwin,
	exportRawNote,
	exportTextbook,
	markdownFileName,
	textbookToMarkdown,
} from './markdown';

const ZWNJ = '‌';
const text = (t: string, ...marks: JSONNode[]): JSONNode => (marks.length ? { type: 'text', text: t, marks } : { type: 'text', text: t });
const para = (...content: JSONNode[]): JSONNode => ({ type: 'paragraph', attrs: { id: 'p' }, content });
const doc = (...content: JSONNode[]): JSONNode => ({ type: 'doc', content });
const REWRITE = { type: 'rewrite' };
const AI = { type: 'aiAdded', attrs: { accepted: false } };
const AI_OK = { type: 'aiAdded', attrs: { accepted: true } };
const GAP = { type: 'gap' };

const FIXTURES = ['persian/zkp-01-basics.txt', 'persian/zkp-01-basics.day2.txt', 'persian/zkp-02-snark.txt', 'persian/export-zwnj.txt'];
const lines = (path: string) =>
	loadFixture(path)
		.split('\n')
		.map(l => l.trimEnd())
		.filter(l => l.length > 0);

/** Lines of the fixture as one doc: paragraphs, a heading, a list and a quote, as a raw note would have. */
function fixtureDoc(path: string): JSONNode {
	const [first, ...rest] = lines(path);
	const content: JSONNode[] = [{ type: 'heading', attrs: { id: 'h', level: 2 }, content: [text(first)] }];
	rest.forEach((l, i) => {
		if (i % 3 === 0) content.push(para(text(l)));
		else if (i % 3 === 1) {
			content.push({ type: 'bulletList', attrs: { id: `l${i}` }, content: [{ type: 'listItem', content: [para(text(l))] }] });
		} else content.push({ type: 'blockquote', attrs: { id: `q${i}` }, content: [para(text(l))] });
	});
	return doc(...content);
}

// ---- Persian, ZWNJ and Latin terms survive unchanged ---------------------------------------------

describe('export keeps text byte-identical', () => {
	it('the ZWNJ fixture really has ZWNJ, Latin terms and text that normalisation would change', () => {
		const t = loadFixture('persian/export-zwnj.txt');
		expect(t).toContain(ZWNJ);
		expect(t).toMatch(/zk-SNARK|Fiat-Shamir|Groth16/);
		expect(normalizePersian(t)).not.toBe(t); // so the test below would catch normalisation (I8)
	});

	for (const path of FIXTURES) {
		it(`every line of ${path} appears unchanged`, () => {
			const md = docToMarkdown(fixtureDoc(path));
			for (const l of lines(path)) expect(md).toContain(l);
			// ZWNJ count is kept exactly: none added, none lost.
			const zwnj = (s: string) => s.split(ZWNJ).length - 1;
			expect(zwnj(md)).toBe(zwnj(lines(path).join('')));
		});

		it(`clean-twin marks around ${path} keep the text unchanged`, () => {
			const ls = lines(path);
			const d = doc(...ls.map((l, i) => para(text(l, REWRITE, ...(i % 2 ? [GAP] : [])), text(` ${l}`, AI_OK))));
			const md = docToMarkdown(d);
			for (const l of ls) expect(md).toContain(`${l} ${l}`);
		});
	}

	it('does not normalise Arabic letters, digits or spacing (I8)', () => {
		const s = 'كتاب علي  ۱۲۳ 123 می' + ZWNJ + 'خواهیم';
		expect(docToMarkdown(doc(para(text(s))))).toBe(`${s}\n`);
	});

	it('keeps Latin terms in Latin and in place (RTL text is not reordered)', () => {
		const s = 'پروتکل Fiat-Shamir و zk-SNARK را با prover می' + ZWNJ + 'سازیم';
		expect(docToMarkdown(doc(para(text(s, REWRITE))))).toBe(`${s}\n`);
	});
});

// ---- provenance (I4) --------------------------------------------------------------------------------

describe('aiAdded and gap spans', () => {
	it('unaccepted aiAdded is wrapped in HTML comments', () => {
		const md = docToMarkdown(doc(para(text('نوشته ', REWRITE), text('افزوده', AI), text(' پایان', REWRITE))));
		expect(md).toBe(`نوشته ${AI_OPEN}افزوده${AI_CLOSE} پایان\n`);
	});

	it('an aiAdded run over several text nodes gets one wrapper, with inner formatting kept', () => {
		const md = docToMarkdown(doc(para(text('الف ', AI), text('پررنگ', AI, { type: 'bold' }), text(' ب', AI))));
		expect(md).toBe(`${AI_OPEN}الف **پررنگ** ب${AI_CLOSE}\n`);
	});

	it('accepted aiAdded exports as plain text', () => {
		const md = docToMarkdown(doc(para(text('نوشته ', REWRITE), text('پذیرفته', AI_OK))));
		expect(md).toBe('نوشته پذیرفته\n');
		expect(md).not.toContain('ai-added');
	});

	it('accepted next to unaccepted: only the unaccepted part is wrapped', () => {
		const md = docToMarkdown(doc(para(text('پذیرفته ', AI_OK), text('نه', AI), text(' باز', AI_OK))));
		expect(md).toBe(`پذیرفته ${AI_OPEN}نه${AI_CLOSE} باز\n`);
	});

	it('keeps the exact boundaries of the span, including its edge whitespace', () => {
		const md = docToMarkdown(doc(para(text('نوشته', REWRITE), text(' افزوده ', AI), text('پایان', REWRITE))));
		expect(md).toBe(`نوشته${AI_OPEN} افزوده ${AI_CLOSE}پایان\n`);
	});

	it('the comment stays outside an inline code span', () => {
		const md = docToMarkdown(doc(para(text('hash(x)', AI, { type: 'code' }))));
		expect(md).toBe(`${AI_OPEN}\`hash(x)\`${AI_CLOSE}\n`);
	});

	it('text that happens to contain private-use characters is kept as is', () => {
		const s = 'الف  ب ';
		expect(docToMarkdown(doc(para(text(s), text('ج', AI))))).toBe(`${s}${AI_OPEN}ج${AI_CLOSE}\n`);
	});

	it('runs in different blocks and list items are wrapped separately', () => {
		const d = doc(
			para(text('یک', AI)),
			{ type: 'bulletList', content: [{ type: 'listItem', content: [para(text('دو', AI), text(' سه'))] }] },
		);
		expect(docToMarkdown(d)).toBe(`${AI_OPEN}یک${AI_CLOSE}\n\n- ${AI_OPEN}دو${AI_CLOSE} سه\n`);
	});

	it('aiAdded without attrs counts as unaccepted', () => {
		expect(docToMarkdown(doc(para(text('x', { type: 'aiAdded' }))))).toBe(`${AI_OPEN}x${AI_CLOSE}\n`);
	});

	it('gap exports as plain text, whatever its attributes', () => {
		for (const gap of [GAP, { type: 'gap', attrs: { reason: 'unclear' } }, { type: 'gap', attrs: { reason: 'term-missing' } }]) {
			expect(docToMarkdown(doc(para(text('مبهم', REWRITE, gap), text(' است'))))).toBe('مبهم است\n');
		}
	});

	it('an unaccepted aiAdded span that is also a gap is wrapped, with no gap trace', () => {
		expect(docToMarkdown(doc(para(text('حدس', AI, GAP))))).toBe(`${AI_OPEN}حدس${AI_CLOSE}\n`);
	});

	it('does not mutate the input document', () => {
		const d = doc(para(text('الف', AI_OK), text('ب', GAP, REWRITE)));
		const before = JSON.stringify(d);
		docToMarkdown(d);
		expect(JSON.stringify(d)).toBe(before);
	});
});

// ---- structure ----------------------------------------------------------------------------------------

describe('Markdown structure', () => {
	it('renders headings, lists, quotes, code and bold/italic; block attrs are not exported', () => {
		const d = doc(
			{ type: 'heading', attrs: { id: 'a', level: 2, sources: ['r'], changedIn: 3 }, content: [text('عنوان')] },
			{ type: 'bulletList', attrs: { id: 'b' }, content: [{ type: 'listItem', content: [para(text('یک'))] }] },
			{ type: 'blockquote', attrs: { id: 'c' }, content: [para(text('نقل'))] },
			{ type: 'codeBlock', attrs: { id: 'd', language: null }, content: [text('x < y *z*')] },
			para(text('پررنگ', { type: 'bold' }), text(' '), text('کج', { type: 'italic' })),
		);
		const md = docToMarkdown(d);
		expect(md).toBe('## عنوان\n\n- یک\n\n> نقل\n\n```\nx < y *z*\n```\n\n**پررنگ** *کج*\n');
		expect(md).not.toMatch(/sources|changedIn|"id"/);
	});

	it('an empty document exports as an empty file', () => {
		expect(docToMarkdown(doc())).toBe('');
	});

	it('file names drop characters file systems reject', () => {
		expect(markdownFileName('مقدمه: ZKP/1', '.clean')).toBe('مقدمه- ZKP-1.clean.md');
		expect(markdownFileName('  ')).toBe('metis.md');
	});
});

// ---- textbook -----------------------------------------------------------------------------------------

const outline: TextbookOutline = {
	version: 1,
	sections: [
		{ id: 's2', title: 'بخش دوم zk-SNARK', sourceFileIds: ['f2'], order: 1 },
		{ id: 's1', title: 'بخش اول', sourceFileIds: ['f1'], order: 0 },
	],
};
const textbook: Textbook = {
	version: 1,
	builtAt: 1,
	sections: {
		s1: { doc: doc(para(text('متن اول', REWRITE), text(' افزوده', AI))), sourceRevisions: { f1: 1 } },
		s2: { doc: doc(para(text('متن دوم', REWRITE, GAP))), sourceRevisions: { f2: 1 } },
	},
	gaps: [{ sectionId: 's2', note: 'soundness تعریف نشده' }],
};

describe('textbook export', () => {
	it('sections in outline order under their titles, then the gaps', () => {
		expect(textbookToMarkdown(outline, textbook)).toBe(
			`## بخش اول\n\nمتن اول${AI_OPEN} افزوده${AI_CLOSE}\n\n## بخش دوم zk-SNARK\n\nمتن دوم\n\n## جاهای خالی\n\n- بخش دوم zk-SNARK: soundness تعریف نشده\n`,
		);
	});

	it('a gap whose section is unknown is listed without a dangling title', () => {
		const tb = { ...textbook, gaps: [{ sectionId: 'gone', note: 'prover مبهم' }] };
		expect(textbookToMarkdown(outline, tb)).toContain('\n\n- prover مبهم\n');
	});

	it('nothing to export without an outline', async () => {
		const empty = { loadOutline: async () => undefined, loadTextbook: async () => undefined };
		expect(await exportTextbook(empty, 'ZKP')).toBeUndefined();
	});
});

// ---- I1: export never writes to the vault -------------------------------------------------------------

async function allFiles(dir: Dir, prefix = ''): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	for (const entry of await dir.list()) {
		const path = prefix + entry.name;
		if (entry.kind === 'file') out.set(path, await canonicalHash({ type: 'file', text: (await dir.readFile(entry.name))! }));
		else for (const [p, h] of await allFiles((await dir.getDir(entry.name))!, `${path}/`)) out.set(p, h);
	}
	return out;
}

describe('I1: export does not modify any vault file', () => {
	it('hashes of every vault file are equal before and after exporting note, clean twin and textbook', async () => {
		const root = new MemoryDir();
		const vault = await createVault(root, 'ZKP');
		const note = await vault.createNote([], 'مبانی');
		const raw = { ...note, doc: textToDoc(loadFixture('persian/export-zwnj.txt')) };
		await vault.saveNote(['مبانی'], raw);
		const twin: CleanNote = {
			version: 1,
			fileId: note.fileId,
			revision: 1,
			doc: doc({ ...para(text('پاک', REWRITE), text(' افزوده', AI)), attrs: { id: 'c1', sources: ['p'], changedIn: 1 } }),
		};
		await vault.derived.saveClean(twin);
		await vault.derived.saveOutline({ ...outline, sections: outline.sections.map(s => ({ ...s, sourceFileIds: [note.fileId] })) });
		await vault.derived.saveTextbook(textbook);

		const before = await allFiles(root);
		expect([...before.keys()].some(p => p.startsWith('notes/'))).toBe(true);
		expect([...before.keys()].some(p => p.startsWith('.metis/clean/'))).toBe(true);
		expect([...before.keys()].some(p => p.startsWith('.metis/textbook/'))).toBe(true);

		const loaded = await vault.loadNote(['مبانی']);
		const r = exportRawNote(loaded);
		const c = await exportCleanTwin(vault.derived, note.fileId, loaded.title);
		const t = await exportTextbook(vault.derived, vault.meta.name);

		expect(await allFiles(root)).toEqual(before);
		expect(r.fileName).toBe('مبانی.md');
		for (const l of lines('persian/export-zwnj.txt')) expect(r.markdown).toContain(l);
		expect(c).toEqual({ fileName: 'مبانی.clean.md', markdown: `پاک${AI_OPEN} افزوده${AI_CLOSE}\n` });
		expect(t?.fileName).toBe('ZKP.textbook.md');
		expect(t?.markdown).toBe(textbookToMarkdown(outline, textbook));
	});

	it('I6: export makes no network request', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch');
		docToMarkdown(fixtureDoc('persian/zkp-01-basics.txt'));
		await exportTextbook({ loadOutline: async () => outline, loadTextbook: async () => textbook }, 'ZKP');
		expect(fetchSpy).not.toHaveBeenCalled();
		fetchSpy.mockRestore();
	});

	it('exporting a note that was never cleaned returns nothing and writes nothing', async () => {
		const root = new MemoryDir();
		const vault = await createVault(root, 'ZKP');
		const note = await vault.createNote([], 'تازه');
		const before = await allFiles(root);
		expect(await exportCleanTwin(vault.derived, note.fileId, note.title)).toBeUndefined();
		expect(await allFiles(root)).toEqual(before);
	});
});
