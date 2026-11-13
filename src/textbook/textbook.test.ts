import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { runClean } from '../clean/clean';
import { canonicalHash, type JSONNode } from '../core/blocks';
import { createMockProvider, type MockProvider } from '../provider/mock';
import type { ChatRequest, Enrichment } from '../provider/types';
import { loadFixture, textToDoc } from '../test/fixtures';
import { MemoryDir, type Dir } from '../vault/dir';
import { createVault, type VaultStore } from '../vault/store';
import type { CleanNote, Textbook, TextbookOutline } from '../vault/types';
import { buildTextbook, staleCount, undoTextbook, type TextbookDeps, type TextbookOptions } from './build';
import { applyDelta } from './delta';
import { CLEAN_TWIN_READER_KEYS, TEXTBOOK_STORE_KEYS, textbookPorts, type CleanTwinReader, type TextbookStore } from './ports';
import { countStaleFiles } from './stale';

// ---- helpers ---------------------------------------------------------------------------------

interface OutlineInput {
	outline: { id: string; title: string; files: string[] }[];
	files: { fileId: string; changed: boolean; headings: string[]; text?: string }[];
}
interface SectionInput {
	title: string;
	outline: string[];
	files: { fileId: string; text: string }[];
}

const isOutline = (req: ChatRequest) => req.messages[0].content.includes('outline (table of contents)');
const input = <T,>(req: ChatRequest): T => JSON.parse(req.messages[1].content);
const sectionCalls = (mock: MockProvider) => mock.calls.filter(c => !isOutline(c) && c.messages.length === 2);
const sectionTitles = (mock: MockProvider) => sectionCalls(mock).map(c => input<SectionInput>(c).title);

type OutlineReply = (inp: OutlineInput) => unknown[];
type SectionReply = (inp: SectionInput) => unknown;

/** Default outline model: one new section per file that no section has yet, titled after the file. */
const addUnassigned: OutlineReply = inp => {
	const assigned = new Set(inp.outline.flatMap(s => s.files));
	return inp.files.filter(f => !assigned.has(f.fileId)).map(f => ({ op: 'add', title: `بخش ${f.fileId}`, files: [f.fileId] }));
};

/** Default section model: every line of the notes as a paragraph, no gaps. */
const echoSection: SectionReply = inp => ({
	blocks: inp.files.flatMap(f => f.text.split('\n').map(line => ({ type: 'paragraph', text: line.replace(/^#+ /, '') }))),
	gaps: [],
});

let outlineReply: OutlineReply;
let sectionReply: SectionReply;

function model(): MockProvider {
	return createMockProvider(req =>
		JSON.stringify(
			isOutline(req) ? { ops: outlineReply(input<OutlineInput>(req)) } : sectionReply(input<SectionInput>(req)),
		),
	);
}

async function files(dir: Dir, prefix = ''): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	for (const entry of await dir.list()) {
		const path = prefix + entry.name;
		if (entry.kind === 'file') out.set(path, (await dir.readFile(entry.name))!);
		else for (const [p, t] of await files((await dir.getDir(entry.name))!, `${path}/`)) out.set(p, t);
	}
	return out;
}

async function rawHashes(root: Dir): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	for (const [path, text] of await files(root)) {
		if (path.startsWith('notes/')) out.set(path, await canonicalHash({ type: 'file', text }));
	}
	return out;
}

/** The textbook outline and textbook files (not history), path -> text. */
async function textbookFiles(root: Dir): Promise<Map<string, string>> {
	return new Map([...(await files(root))].filter(([p]) => /^\.metis\/textbook\/[^/]+$/.test(p)));
}

const rewrite = (text: string): JSONNode => ({ type: 'text', text, marks: [{ type: 'rewrite' }] });

function cleanTwin(fileId: string, revision: number, fixture: string): CleanNote {
	const content = textToDoc(loadFixture(fixture)).content!.map((b, i) => ({
		type: 'paragraph',
		attrs: { id: `c${i}`, sources: [`r${i}`], changedIn: revision },
		content: (b.content ?? []).map(t => rewrite(t.text as string)),
	}));
	return { version: 1, fileId, revision, doc: { type: 'doc', content } };
}

let root: MemoryDir;
let vault: VaultStore;
let mock: MockProvider;
let deps: TextbookDeps;
const options: TextbookOptions = { enrichment: 'flag-gaps', now: () => 1000 };

const build = (opts: Partial<TextbookOptions> = {}) => buildTextbook(deps, { ...options, ...opts });
const outline = async () => (await vault.derived.loadOutline()) as TextbookOutline;
const textbook = async () => (await vault.derived.loadTextbook()) as Textbook;
const titled = async (title: string) => (await outline()).sections.find(s => s.title === title)!;

beforeEach(async () => {
	root = new MemoryDir();
	vault = await createVault(root, 'ZKP');
	outlineReply = addUnassigned;
	sectionReply = echoSection;
	mock = model();
	deps = { ...textbookPorts(vault.derived), provider: mock };
	await vault.derived.saveClean(cleanTwin('f1', 1, 'persian/zkp-01-basics.txt'));
	await vault.derived.saveClean(cleanTwin('f2', 1, 'persian/zkp-02-snark.txt'));
});

// ---- build, I7 -----------------------------------------------------------------------------------

describe('textbook build', () => {
	it('first build: one outline delta, one call per section, every section built from clean twins', async () => {
		const report = await build();
		expect(report).toMatchObject({ changed: true, modelCalls: 3, failed: [] });
		expect(mock.calls.every(c => c.json)).toBe(true);
		const o = await outline();
		expect(o.sections.map(s => [s.title, s.sourceFileIds, s.order])).toEqual([
			['بخش f1', ['f1'], 0],
			['بخش f2', ['f2'], 1],
		]);
		expect(report.outline.added).toEqual(o.sections.map(s => s.id));
		const t = await textbook();
		expect(Object.keys(t.sections).sort()).toEqual(o.sections.map(s => s.id).sort());
		expect(t.sections[o.sections[0].id].sourceRevisions).toEqual({ f1: 1 });
		expect(t.builtAt).toBe(1000);
		// Latin technical terms reach the model and come back as written.
		expect(JSON.stringify(t)).toContain('zk-snark');
		expect(sectionCalls(mock)[1].messages[1].content).toContain('zk-snark');
	});

	it('a second build with nothing changed makes zero model calls and writes nothing (I7)', async () => {
		await build();
		const before = await files(root);
		mock.reset();
		const report = await build({ now: () => 2000 });
		expect(report).toMatchObject({ changed: false, modelCalls: 0, regenerated: [] });
		expect(await files(root)).toEqual(before);
	});

	it('regenerates only the section whose source file has a newer clean revision; ids and order stay (I7)', async () => {
		await vault.derived.saveClean(cleanTwin('f3', 1, 'persian/zkp-01-basics.day2.txt'));
		await build();
		const o1 = await outline();
		const t1 = await textbook();

		await vault.derived.saveClean(cleanTwin('f2', 2, 'persian/zkp-02-snark.txt'));
		mock.reset();
		const report = await build({ now: () => 2000 });

		expect(mock.callCount).toBe(2); // the delta, then the one stale section
		expect(sectionTitles(mock)).toEqual(['بخش f2']);
		expect(await outline()).toEqual(o1);
		const t2 = await textbook();
		const [s1, s2, s3] = o1.sections.map(s => s.id);
		expect(report.regenerated).toEqual([s2]);
		expect(JSON.stringify(t2.sections[s1])).toBe(JSON.stringify(t1.sections[s1]));
		expect(JSON.stringify(t2.sections[s3])).toBe(JSON.stringify(t1.sections[s3]));
		expect(t2.sections[s2].sourceRevisions).toEqual({ f2: 2 });
		expect(t2.builtAt).toBe(2000);
	});

	it('a rename or reorder keeps section ids and regenerates nothing', async () => {
		await vault.derived.saveClean(cleanTwin('f3', 1, 'persian/zkp-01-basics.day2.txt'));
		await build();
		const [a, b, c] = (await outline()).sections;
		const t1 = await textbook();

		await vault.derived.saveClean(cleanTwin('f3', 2, 'persian/zkp-01-basics.day2.txt'));
		outlineReply = () => [
			{ op: 'rename', id: a.id, title: 'مبانی ZKP' },
			{ op: 'reorder', ids: [c.id, a.id, b.id] },
		];
		mock.reset();
		const report = await build();
		const o2 = await outline();
		expect(o2.sections.map(s => [s.id, s.title, s.order])).toEqual([
			[c.id, c.title, 0],
			[a.id, 'مبانی ZKP', 1],
			[b.id, b.title, 2],
		]);
		expect(report.outline).toMatchObject({ renamed: [a.id], reordered: true, added: [] });
		// Only f3 changed: only its section is regenerated, not the renamed one.
		expect(report.regenerated).toEqual([c.id]);
		expect(JSON.stringify((await textbook()).sections[a.id])).toBe(JSON.stringify(t1.sections[a.id]));
	});

	it('merge keeps the first id and regenerates it from both files; the merged section is gone', async () => {
		await build();
		const [a, b] = (await outline()).sections;
		await vault.derived.saveClean(cleanTwin('f2', 2, 'persian/zkp-02-snark.txt'));
		outlineReply = () => [{ op: 'merge', ids: [a.id, b.id], title: 'اثبات دانش‌صفر' }];
		mock.reset();
		const report = await build();
		const o = await outline();
		expect(o.sections).toEqual([{ id: a.id, title: 'اثبات دانش‌صفر', sourceFileIds: ['f1', 'f2'], order: 0 }]);
		expect(report.outline.merged).toEqual([{ into: a.id, removed: [b.id] }]);
		expect(report.regenerated).toEqual([a.id]);
		const t = await textbook();
		expect(Object.keys(t.sections)).toEqual([a.id]);
		expect(t.sections[a.id].sourceRevisions).toEqual({ f1: 1, f2: 2 });
	});

	it('a new file can be assigned to an existing section, or added after one', async () => {
		await build();
		const [a, b] = (await outline()).sections;
		await vault.derived.saveClean(cleanTwin('f3', 1, 'persian/zkp-01-basics.day2.txt'));
		await vault.derived.saveClean(cleanTwin('f4', 1, 'persian/zkp-02-snark.txt'));
		outlineReply = () => [
			{ op: 'assign', id: a.id, files: ['f3'] },
			{ op: 'add', title: 'SNARK در عمل', files: ['f4'], after: a.id },
		];
		mock.reset();
		const report = await build();
		const o = await outline();
		expect(o.sections.map(s => [s.id === a.id || s.id === b.id ? s.id : 'new', s.sourceFileIds, s.order])).toEqual([
			[a.id, ['f1', 'f3'], 0],
			['new', ['f4'], 1],
			[b.id, ['f2'], 2],
		]);
		expect(report.outline.assigned).toEqual([a.id]);
		expect(report.regenerated).toEqual([a.id, o.sections[1].id]);
	});

	it('drops sections whose files have no clean twin any more', async () => {
		await build();
		const [, b] = (await outline()).sections;
		await vault.derived.deleteClean('f2');
		mock.reset();
		const report = await build();
		expect(mock.callCount).toBe(0);
		expect(report.outline.dropped).toEqual([b.id]);
		expect((await outline()).sections).toHaveLength(1);
		expect(Object.keys((await textbook()).sections)).not.toContain(b.id);
	});

	it('a vault without clean twins builds nothing', async () => {
		await vault.derived.deleteClean('f1');
		await vault.derived.deleteClean('f2');
		expect(await build()).toMatchObject({ changed: false, modelCalls: 0 });
		expect(await vault.derived.loadOutline()).toBeUndefined();
	});

	it('a provider error aborts the build and writes nothing', async () => {
		await build();
		const before = await files(root);
		await vault.derived.saveClean(cleanTwin('f2', 2, 'persian/zkp-02-snark.txt'));
		const afterClean = await files(root);
		expect(afterClean).not.toEqual(before);
		deps.provider = createMockProvider(() => {
			throw new Error('offline');
		});
		await expect(build()).rejects.toThrow('offline');
		expect(await files(root)).toEqual(afterClean);
	});
});

// ---- validation and retry --------------------------------------------------------------------

describe('validation', () => {
	it('retries an invalid section once, then accepts a valid reply', async () => {
		let n = 0;
		sectionReply = inp => (inp.title === 'بخش f1' && n++ === 0 ? { blocks: [] } : echoSection(inp));
		const report = await build();
		expect(report).toMatchObject({ modelCalls: 4, failed: [] });
		const retry = mock.calls.find(c => c.messages.length === 4)!;
		expect(retry.messages[3].content).toContain('no blocks');
	});

	it('leaves a section untouched after a second invalid reply, reports it, and keeps it stale', async () => {
		await build();
		const [a, b] = (await outline()).sections;
		const t1 = await textbook();
		await vault.derived.saveClean(cleanTwin('f1', 2, 'persian/zkp-01-basics.txt'));
		await vault.derived.saveClean(cleanTwin('f2', 2, 'persian/zkp-02-snark.txt'));
		sectionReply = inp => (inp.title === a.title ? 'not json' : echoSection(inp));
		mock.reset();
		const report = await build();
		expect(report.failed).toEqual([{ sectionId: a.id, error: expect.stringContaining('expected') }]);
		expect(report.regenerated).toEqual([b.id]);
		expect(mock.callCount).toBe(4); // delta + 2 tries for a + 1 for b
		expect(JSON.stringify((await textbook()).sections[a.id])).toBe(JSON.stringify(t1.sections[a.id]));
		expect(await staleCount(deps.clean, deps.store)).toBe(1);
	});

	it('leaves the outline untouched after a second invalid delta and reports it', async () => {
		await build();
		const o1 = await outline();
		await vault.derived.saveClean(cleanTwin('f3', 1, 'persian/zkp-01-basics.day2.txt'));
		outlineReply = () => [{ op: 'rename', id: 'no-such-section', title: 'x' }];
		mock.reset();
		const report = await build();
		expect(report.outlineError).toContain('unknown section id');
		expect(mock.callCount).toBe(2);
		expect(await outline()).toEqual(o1);
		expect(await staleCount(deps.clean, deps.store)).toBe(1); // f3 is still in no section
	});
});

describe('applyDelta', () => {
	const base: TextbookOutline = {
		version: 1,
		sections: [
			{ id: 'a', title: 'الف', sourceFileIds: ['f1'], order: 0 },
			{ id: 'b', title: 'ب', sourceFileIds: ['f2'], order: 1 },
		],
	};
	let n = 0;
	const id = () => `new${n++}`;
	const apply = (ops: unknown[], fileIds = ['f1', 'f2']) => applyDelta(JSON.stringify({ ops }), base, fileIds, id);

	it('an empty delta changes nothing', () => {
		const r = apply([]);
		expect(r.ok && r.outline).toEqual(base);
	});

	it('rejects unknown ids, unknown files, bad reorders, uncovered files and unknown ops', () => {
		const bad: [unknown[], string, string[]?][] = [
			[[{ op: 'rename', id: 'x', title: 'y' }], 'unknown section id'],
			[[{ op: 'rename', id: 'a', title: '  ' }], 'title'],
			[[{ op: 'assign', id: 'a', files: ['f9'] }], 'unknown file id'],
			[[{ op: 'reorder', ids: ['a'] }], 'every existing section'],
			[[{ op: 'reorder', ids: ['b', 'a'] }, { op: 'reorder', ids: ['a', 'b'] }], 'at most one'],
			[[{ op: 'merge', ids: ['a'] }], 'at least two'],
			[[{ op: 'merge', ids: ['a', 'b'] }, { op: 'rename', id: 'b', title: 'x' }], 'unknown section id'],
			[[{ op: 'add', title: 'ج', files: ['f3'], after: 'zz' }], 'unknown section id', ['f1', 'f2', 'f3']],
			[[], 'no section has file "f3"', ['f1', 'f2', 'f3']],
			[[{ op: 'delete', id: 'a' }], 'unknown op'],
		];
		for (const [ops, error, fileIds] of bad) {
			const r = apply(ops, fileIds);
			expect(r.ok, JSON.stringify(ops)).toBe(false);
			if (!r.ok) expect(r.error).toContain(error);
		}
		expect(applyDelta('{', base, [], id)).toEqual({ ok: false, error: 'not valid JSON' });
	});

	it('mints ids for added sections, never takes them from the model, and does not mutate the input', () => {
		const copy = structuredClone(base);
		const r = apply(
			[
				{ op: 'add', id: 'model-id', title: 'ج', files: ['f3'] },
				{ op: 'merge', ids: ['a', 'b'] },
			],
			['f1', 'f2', 'f3'],
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.outline.sections.map(s => s.id)).toEqual(['a', expect.stringMatching(/^new/)]);
		expect(r.outline.sections[0].sourceFileIds).toEqual(['f1', 'f2']);
		expect(base).toEqual(copy);
	});
});

// ---- undo ------------------------------------------------------------------------------------

describe('undo', () => {
	it('restores the previous outline and textbook exactly, one build at a time', async () => {
		expect(await undoTextbook(deps.store)).toBe(false);
		await build();
		const after1 = await textbookFiles(root);
		const [a] = (await outline()).sections;
		await vault.derived.saveClean(cleanTwin('f3', 1, 'persian/zkp-01-basics.day2.txt'));
		outlineReply = () => [
			{ op: 'assign', id: a.id, files: ['f3'] },
			{ op: 'rename', id: a.id, title: 'تازه' },
		];
		await build({ now: () => 2000 });
		expect(await textbookFiles(root)).not.toEqual(after1);

		expect(await undoTextbook(deps.store)).toBe(true);
		expect(await textbookFiles(root)).toEqual(after1);
		expect(await undoTextbook(deps.store)).toBe(true);
		expect(await textbookFiles(root)).toEqual(new Map());
		expect(await undoTextbook(deps.store)).toBe(false);
		expect(await vault.derived.listTextbookSnapshots()).toEqual([]);
	});
});

// ---- gaps, provenance (I4) -------------------------------------------------------------------

function textNodes(node: JSONNode): JSONNode[] {
	return typeof node.text === 'string' ? [node] : (node.content ?? []).flatMap(textNodes);
}

describe('gaps and provenance', () => {
	it('collects gaps from the model and from <gap> spans; unchanged sections keep theirs', async () => {
		sectionReply = inp =>
			inp.title === 'بخش f1'
				? { blocks: [{ type: 'paragraph', text: 'prover باید <gap>چیزی</gap> را ثابت کند' }], gaps: ['تعریف soundness ناقص است'] }
				: echoSection(inp);
		await build();
		const [a, b] = (await outline()).sections;
		expect((await textbook()).gaps).toEqual([
			{ sectionId: a.id, note: 'تعریف soundness ناقص است' },
			{ sectionId: a.id, note: 'چیزی' },
		]);

		await vault.derived.saveClean(cleanTwin('f2', 2, 'persian/zkp-02-snark.txt'));
		sectionReply = inp => ({ ...(echoSection(inp) as object), gaps: ['trusted setup توضیح ندارد'] });
		await build();
		expect((await textbook()).gaps).toEqual([
			{ sectionId: a.id, note: 'تعریف soundness ناقص است' },
			{ sectionId: a.id, note: 'چیزی' },
			{ sectionId: b.id, note: 'trusted setup توضیح ندارد' },
		]);
	});

	it('every text span carries provenance; <ai> becomes a distinct aiAdded mark only with light-add', async () => {
		sectionReply = () => ({
			blocks: [
				{ type: 'heading', text: 'zk-SNARK' },
				{ type: 'paragraph', text: 'prover اثبات را <ai>به verifier</ai> می‌فرستد' },
				{ type: 'bulletList', items: ['succinct', 'non-interactive <gap>?</gap>'] },
				{ type: 'codeBlock', text: 'verify(proof)' },
			],
		});
		const report = await build({ enrichment: 'light-add' });
		expect(report.failed).toEqual([]);
		const t = await textbook();
		const blocks = Object.values(t.sections).flatMap(s => s.doc.content!);
		// Code blocks allow no marks: their text carries none, and the provenance rule skips them.
		const code = blocks.filter(b => b.type === 'codeBlock');
		expect(code.length).toBeGreaterThan(0);
		for (const b of code) expect(b.content).toEqual([{ type: 'text', text: 'verify(proof)' }]);
		const spans = blocks.filter(b => b.type !== 'codeBlock').flatMap(textNodes);
		expect(spans.length).toBeGreaterThan(0);
		for (const span of spans) {
			const types = span.marks!.map(m => m.type);
			expect(types.includes('rewrite') !== types.includes('aiAdded'), JSON.stringify(span)).toBe(true);
		}
		const ai = spans.filter(s => s.marks!.some(m => m.type === 'aiAdded'));
		expect(ai.map(s => s.text)).toEqual(['به verifier', 'به verifier']);
		expect(ai[0].marks).toEqual([{ type: 'aiAdded', attrs: { accepted: false } }]);
		for (const doc of Object.values(t.sections).map(s => s.doc)) {
			expect(doc.content!.every(n => typeof n.attrs?.id === 'string')).toBe(true);
		}
	});

	it('rejects <ai> outside light-add, in headings, and blocks made only of added text', async () => {
		const cases: [Enrichment, unknown][] = [
			['flag-gaps', { type: 'paragraph', text: 'متن <ai>اضافه</ai>' }],
			['off', { type: 'paragraph', text: 'متن <ai>اضافه</ai>' }],
			['light-add', { type: 'heading', text: 'عنوان <ai>تازه</ai>' }],
			['light-add', { type: 'paragraph', text: '<ai>یک پاراگراف تازه</ai>' }],
			['light-add', { type: 'bulletList', items: ['از یادداشت', '<ai>مورد تازه</ai>'] }],
		];
		for (const [enrichment, block] of cases) {
			await vault.derived.deleteOutline();
			await vault.derived.deleteTextbook();
			sectionReply = () => ({ blocks: [block] });
			mock.reset();
			const report = await build({ enrichment });
			expect(report.failed, JSON.stringify(block)).toHaveLength(2);
			expect(mock.callCount).toBe(5);
		}
	});

	it('sends clean text only: unaccepted aiAdded spans are left out, accepted ones and gaps kept', async () => {
		const twin: CleanNote = {
			version: 1,
			fileId: 'f1',
			revision: 1,
			doc: {
				type: 'doc',
				content: [
					{
						type: 'paragraph',
						attrs: { id: 'c1', sources: ['r1'], changedIn: 1 },
						content: [
							rewrite('prover '),
							{ type: 'text', text: 'حدس مدل', marks: [{ type: 'aiAdded', attrs: { accepted: false } }] },
							{ type: 'text', text: 'پذیرفته', marks: [{ type: 'aiAdded', attrs: { accepted: true } }] },
							{ type: 'text', text: ' مبهم', marks: [{ type: 'rewrite' }, { type: 'gap' }] },
						],
					},
				],
			},
		};
		await vault.derived.saveClean(twin);
		await build();
		const sent = input<SectionInput>(sectionCalls(mock)[0]).files[0].text;
		expect(sent).toBe('prover پذیرفته<gap> مبهم</gap>');
	});
});

// ---- stale count -----------------------------------------------------------------------------

describe('countStaleFiles', () => {
	const o: TextbookOutline = {
		version: 1,
		sections: [
			{ id: 'a', title: 'الف', sourceFileIds: ['f1', 'f2'], order: 0 },
			{ id: 'b', title: 'ب', sourceFileIds: ['f2'], order: 1 },
		],
	};
	const doc = { type: 'doc', content: [] };
	const t = (a: Record<string, number>, b?: Record<string, number>): Textbook => ({
		version: 1,
		builtAt: 0,
		sections: { a: { doc, sourceRevisions: a }, ...(b ? { b: { doc, sourceRevisions: b } } : {}) },
		gaps: [],
	});

	it('counts every file when there is no textbook yet, none when all are built', () => {
		expect(countStaleFiles({ f1: 1, f2: 1 }, undefined, undefined)).toBe(2);
		expect(countStaleFiles({}, undefined, undefined)).toBe(0);
		expect(countStaleFiles({ f1: 1, f2: 3 }, o, t({ f1: 1, f2: 3 }, { f2: 3 }))).toBe(0);
	});

	it('counts files with a newer clean revision, files in no section, and files of unbuilt sections', () => {
		expect(countStaleFiles({ f1: 2, f2: 3 }, o, t({ f1: 1, f2: 3 }, { f2: 3 }))).toBe(1);
		expect(countStaleFiles({ f1: 1, f2: 3 }, o, t({ f1: 1, f2: 3 }, { f2: 2 }))).toBe(1);
		expect(countStaleFiles({ f1: 1, f2: 3, f3: 1 }, o, t({ f1: 1, f2: 3 }, { f2: 3 }))).toBe(1);
		expect(countStaleFiles({ f1: 1, f2: 3 }, o, t({ f1: 1, f2: 3 }))).toBe(1);
	});

	it('is pure: same input, same output, input untouched', () => {
		const rev = { f1: 2, f2: 3 };
		const tb = t({ f1: 1, f2: 3 }, { f2: 3 });
		const snapshot = JSON.stringify([rev, o, tb]);
		expect(countStaleFiles(rev, o, tb)).toBe(countStaleFiles(rev, o, tb));
		expect(JSON.stringify([rev, o, tb])).toBe(snapshot);
	});

	it('the vault count follows clean revisions and builds', async () => {
		expect(await staleCount(deps.clean, deps.store)).toBe(2);
		await build();
		expect(await staleCount(deps.clean, deps.store)).toBe(0);
		await vault.derived.saveClean(cleanTwin('f1', 2, 'persian/zkp-01-basics.txt'));
		expect(await staleCount(deps.clean, deps.store)).toBe(1);
	});
});

// ---- I1 ----------------------------------------------------------------------------------------

describe('I1: textbook code reads clean twins only and never writes raw notes', () => {
	it('fixture vault: clean, then build; raw notes are byte-identical and only clean twins reach the model', async () => {
		const notes = [
			['zkp-01', 'persian/zkp-01-basics.txt'],
			['zkp-02', 'persian/zkp-02-snark.txt'],
		];
		const fresh = new MemoryDir();
		const v = await createVault(fresh, 'ZKP');
		const cleanModel = createMockProvider(req =>
			JSON.stringify({
				blocks: JSON.parse(req.messages[1].content).blocks.map((b: { id: string; text: string }) => ({
					type: 'paragraph',
					text: `پاک: ${b.text}`,
					sources: [b.id],
				})),
			}),
		);
		for (const [name, fixture] of notes) {
			const note = await v.createNote([], name);
			const content = textToDoc(loadFixture(fixture)).content!.map((b, i) => ({ ...b, attrs: { id: `${name}-${i}` } }));
			await v.saveNote([name], { ...note, doc: { type: 'doc', content } });
			await runClean(
				{ notes: { loadNote: p => v.loadNote(p) }, derived: v.derived, provider: cleanModel },
				[name],
				{ rewriteLevel: 'structure', enrichment: 'flag-gaps' },
			);
		}
		const hashes = await rawHashes(fresh);
		expect(hashes.size).toBe(2);

		const only = <T extends object>(target: T, allowed: string[]): T =>
			new Proxy(target, {
				get(t, key) {
					if (typeof key === 'string' && !allowed.includes(key)) throw new Error(`textbook code touched ${key}`);
					return Reflect.get(t, key);
				},
			});
		const ports = textbookPorts(v.derived);
		const clean: CleanTwinReader = only(ports.clean, CLEAN_TWIN_READER_KEYS);
		const store: TextbookStore = only(ports.store, TEXTBOOK_STORE_KEYS);
		expect(Object.keys(ports.clean).sort()).toEqual([...CLEAN_TWIN_READER_KEYS].sort());
		expect(Object.keys(ports.store).sort()).toEqual([...TEXTBOOK_STORE_KEYS].sort());

		const report = await buildTextbook({ clean, store, provider: mock }, options);
		expect(report).toMatchObject({ changed: true, failed: [] });
		await undoTextbook(store);
		await buildTextbook({ clean, store, provider: mock }, options);
		expect(await rawHashes(fresh)).toEqual(hashes);
		// Every section prompt carries the clean text (with its "پاک:" prefix), never a raw line on its own.
		for (const call of sectionCalls(mock)) {
			for (const f of input<SectionInput>(call).files) {
				for (const line of f.text.split('\n')) expect(line.startsWith('پاک: ')).toBe(true);
			}
		}
	});

	it('textbook sources never reference VaultStore, raw notes or a note-writing API', () => {
		const src = join(import.meta.dirname, '..');
		const paths = [
			...readdirSync(join(src, 'textbook'))
				.filter(f => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
				.map(f => join(src, 'textbook', f)),
			join(src, 'prompts', 'textbook.ts'),
		];
		expect(paths.length).toBeGreaterThan(5);
		for (const path of paths) {
			const text = readFileSync(path, 'utf8');
			const name = relative(src, path);
			expect(text, name).not.toMatch(
				/\bVaultStore\b|\bNoteReader\b|RawNote|loadNote|saveNote|createNote|renameNote|createVault|openVault|\bDir\b|notes\//,
			);
			for (const m of text.matchAll(/^import\s+(type\s+)?[^;]*?from\s+'([^']+)'/gm)) {
				if (/vault\/|clean\//.test(m[2])) expect(m[1], `${name} imports ${m[2]} for values`).toBe('type ');
			}
		}
	});
});
