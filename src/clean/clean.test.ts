import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalHash, type JSONNode } from '../core/blocks';
import { createMockProvider, type MockProvider } from '../provider/mock';
import type { ChatRequest } from '../provider/types';
import { loadFixture, textToDoc } from '../test/fixtures';
import { MemoryDir, type Dir } from '../vault/dir';
import { createVault, type VaultPath, type VaultStore } from '../vault/store';
import type { CleanNote, SyncState } from '../vault/types';
import { runClean, undoClean, type CleanDeps, type CleanOptions } from './clean';
import { diffBlocks } from './diff';
import type { CleanDerivedStore, RawNoteReader } from './ports';

// ---- helpers ---------------------------------------------------------------------------------

interface Payload {
	blocks: { id: string; text: string; previousClean?: string }[];
	contextBefore: string[];
	contextAfter: string[];
}
const payload = (req: ChatRequest): Payload => JSON.parse(req.messages[1].content);
const sentIds = (mock: MockProvider) => mock.calls.filter(c => c.messages.length === 2).flatMap(c => payload(c).blocks.map(b => b.id));

/** A model that cleans each block into one paragraph. */
const echo = (req: ChatRequest) =>
	JSON.stringify({ blocks: payload(req).blocks.map(b => ({ type: 'paragraph', text: `پاک: ${b.text}`, sources: [b.id] })) });

const para = (id: string, text: string): JSONNode => ({ type: 'paragraph', attrs: { id }, content: [{ type: 'text', text }] });
const empty = (id: string): JSONNode => ({ type: 'paragraph', attrs: { id } });

function fixtureBlocks(path: string, prefix: string): JSONNode[] {
	return textToDoc(loadFixture(path)).content!.map((b, i) => ({ ...b, attrs: { id: `${prefix}${i}` } }));
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

let root: MemoryDir;
let vault: VaultStore;
let path: VaultPath;
let fileId: string;
let mock: MockProvider;
let deps: CleanDeps;
const options: CleanOptions = { rewriteLevel: 'structure', enrichment: 'flag-gaps' };

async function write(content: JSONNode[]) {
	const note = await vault.loadNote(path);
	// The editor's save: the only writer of notes/**.
	await vault.saveNote(path, { ...note, doc: { type: 'doc', content } });
}

const clean = (opts: Partial<CleanOptions> = {}) => runClean(deps, path, { ...options, ...opts });
const loadClean = async () => (await vault.derived.loadClean(fileId)) as CleanNote;
const loadSync = async () => (await vault.derived.loadSync(fileId)) as SyncState;
const cleanFor = (note: CleanNote, rawId: string) =>
	note.doc.content!.filter(n => (n.attrs!.sources as string[]).includes(rawId));

beforeEach(async () => {
	root = new MemoryDir();
	vault = await createVault(root, 'ZKP');
	const note = await vault.createNote([], 'zkp-01');
	path = ['zkp-01'];
	fileId = note.fileId;
	mock = createMockProvider(echo);
	// Narrow ports only (I1): a reader with loadNote, and the derived store.
	deps = { notes: { loadNote: p => vault.loadNote(p) }, derived: vault.derived, provider: mock };
});

const day1 = () => fixtureBlocks('persian/zkp-01-basics.txt', 'a');
const day2 = () => fixtureBlocks('persian/zkp-01-basics.day2.txt', 'b');

// ---- fixture run (I1, I3) ----------------------------------------------------------------------

describe('incremental clean of the zkp-01 fixture', () => {
	it('day 2 sends only the appended blocks to the model and keeps day 1 clean blocks byte-identical (I3)', async () => {
		await write([...day1(), empty('e1')]);
		const hashes0 = await rawHashes(root);

		const r1 = await clean();
		expect(r1).toMatchObject({ changed: true, revision: 1, failed: [] });
		expect(sentIds(mock)).toEqual(day1().map(b => b.attrs!.id));
		const clean1 = await loadClean();
		expect(clean1.doc.content).toHaveLength(day1().length);
		expect(await rawHashes(root)).toEqual(hashes0); // I1

		await write([...day1(), ...day2(), empty('e2')]);
		const hashes1 = await rawHashes(root);
		mock.reset();
		const r2 = await clean();
		expect(r2).toMatchObject({ changed: true, revision: 2, failed: [] });
		expect(sentIds(mock)).toEqual(day2().map(b => b.attrs!.id));
		expect(await rawHashes(root)).toEqual(hashes1); // I1

		const clean2 = await loadClean();
		for (const block of day1()) {
			const id = block.attrs!.id as string;
			expect(JSON.stringify(cleanFor(clean2, id))).toBe(JSON.stringify(cleanFor(clean1, id)));
			expect((await loadSync()).blocks[id].lastRevision).toBe(1);
		}
		for (const block of day2()) {
			const nodes = cleanFor(clean2, block.attrs!.id as string);
			expect(nodes).toHaveLength(1);
			expect(nodes[0].attrs!.changedIn).toBe(2);
		}
		// Order follows raw order.
		expect(clean2.doc.content!.map(n => (n.attrs!.sources as string[])[0])).toEqual(
			[...day1(), ...day2()].map(b => b.attrs!.id),
		);
		// Day 2 got the last day 1 clean blocks as read-only context.
		expect(payload(mock.calls[0]).contextBefore).toEqual(
			clean1.doc.content!.slice(-2).map(n => n.content![0].text),
		);
	});

	it('a second clean with no edits makes no model call and writes nothing (I3)', async () => {
		await write(day1());
		await clean();
		const before = await files(root);
		mock.reset();
		const r = await clean();
		expect(r).toMatchObject({ changed: false, revision: 1, modelCalls: 0 });
		expect(mock.callCount).toBe(0);
		expect(await files(root)).toEqual(before);
	});

	it('an edit that normalisation erases (Arabic ي, tatweel, spaces) is not a change', async () => {
		await write([para('p1', 'علی میگه کتاب ها'), para('p2', 'دوم')]);
		await clean();
		mock.reset();
		await write([para('p1', 'علي  ميـگه کتاب ها'), para('p2', 'دوم')]);
		expect(await clean()).toMatchObject({ changed: false, modelCalls: 0 });
	});

	it('the model sees the normalised text', async () => {
		await write([para('p1', 'كتاب ها ٠')]);
		await clean();
		expect(payload(mock.calls[0]).blocks[0].text).toBe('کتاب‌ها ۰');
	});
});

// ---- diff cases -------------------------------------------------------------------------------

describe('block diff and splice', () => {
	beforeEach(async () => {
		await write([para('p1', 'یک'), para('p2', 'دو'), para('p3', 'سه'), para('p4', 'چهار')]);
		await clean();
		mock.reset();
	});

	it('a changed block is the only one sent, with its previous clean text', async () => {
		const before = await loadClean();
		await write([para('p1', 'یک'), para('p2', 'دو و نیم'), para('p3', 'سه'), para('p4', 'چهار')]);
		await clean();
		expect(sentIds(mock)).toEqual(['p2']);
		expect(payload(mock.calls[0]).blocks[0]).toEqual({ id: 'p2', text: 'دو و نیم', previousClean: 'پاک: دو' });
		expect(payload(mock.calls[0]).contextBefore).toEqual(['پاک: یک']);
		expect(payload(mock.calls[0]).contextAfter).toEqual(['پاک: سه', 'پاک: چهار']);
		const after = await loadClean();
		expect(cleanFor(after, 'p2')[0].content![0].text).toBe('پاک: دو و نیم');
		for (const id of ['p1', 'p3', 'p4']) expect(cleanFor(after, id)).toEqual(cleanFor(before, id));
	});

	it('a moved block causes no model call; its clean block is only reordered', async () => {
		const before = await loadClean();
		await write([para('p3', 'سه'), para('p1', 'یک'), para('p2', 'دو'), para('p4', 'چهار')]);
		const r = await clean();
		expect(mock.callCount).toBe(0);
		expect(r.changed).toBe(true);
		const after = await loadClean();
		expect(after.doc.content!.map(n => (n.attrs!.sources as string[])[0])).toEqual(['p3', 'p1', 'p2', 'p4']);
		for (const id of ['p1', 'p2', 'p3', 'p4']) {
			expect(JSON.stringify(cleanFor(after, id))).toBe(JSON.stringify(cleanFor(before, id)));
		}
	});

	it('a deleted raw block removes its clean block and sync entry without a model call', async () => {
		await write([para('p1', 'یک'), para('p3', 'سه'), para('p4', 'چهار')]);
		await clean();
		expect(mock.callCount).toBe(0);
		expect(cleanFor(await loadClean(), 'p2')).toEqual([]);
		expect((await loadClean()).doc.content).toHaveLength(3);
		expect(Object.keys((await loadSync()).blocks)).toEqual(['p1', 'p3', 'p4']);
	});

	it('empty paragraphs are skipped; horizontal rules and code blocks are kept without a model call', async () => {
		const hr: JSONNode = { type: 'horizontalRule', attrs: { id: 'hr' } };
		const code: JSONNode = { type: 'codeBlock', attrs: { id: 'cb' }, content: [{ type: 'text', text: 'x  =  ي' }] };
		await write([empty('e0'), para('p1', 'یک'), empty('e1'), hr, para('p2', 'دو'), code, para('p3', 'سه'), para('p4', 'چهار'), empty('e2')]);
		await clean();
		expect(mock.callCount).toBe(0);
		const sync = await loadSync();
		expect(Object.keys(sync.blocks)).toEqual(['p1', 'hr', 'p2', 'cb', 'p3', 'p4']);
		const c = await loadClean();
		expect(c.doc.content!.map(n => n.type)).toEqual(['paragraph', 'horizontalRule', 'paragraph', 'codeBlock', 'paragraph', 'paragraph']);
		expect(cleanFor(c, 'cb')[0].content![0].text).toBe('x  =  ي');
		expect(cleanFor(c, 'hr')[0].attrs).toMatchObject({ sources: ['hr'], changedIn: 2 });
	});

	it('new blocks on both sides of an unchanged block are two batches', async () => {
		await write([para('n1', 'الف'), para('p1', 'یک'), para('n2', 'ب'), para('p2', 'دو'), para('p3', 'سه'), para('p4', 'چهار')]);
		await clean();
		expect(mock.calls.map(c => payload(c).blocks.map(b => b.id))).toEqual([['n1'], ['n2']]);
	});

	it('maxBatchBlocks splits a long run of new blocks', async () => {
		await write([1, 2, 3, 4, 5].map(i => para(`n${i}`, `متن ${i}`)));
		await clean({ maxBatchBlocks: 2 });
		expect(mock.calls.map(c => payload(c).blocks.map(b => b.id))).toEqual([['n1', 'n2'], ['n3', 'n4'], ['n5']]);
	});
});

describe('clean blocks with several sources', () => {
	const merge = (req: ChatRequest) => {
		const blocks = payload(req).blocks;
		return JSON.stringify({ blocks: [{ type: 'paragraph', text: blocks.map(b => b.text).join(' + '), sources: blocks.map(b => b.id) }] });
	};

	beforeEach(async () => {
		mock = createMockProvider(merge);
		deps = { ...deps, provider: mock };
		await write([para('p1', 'یک'), para('p2', 'دو'), para('p3', 'سه')]);
		await clean();
		mock.reset();
	});

	it('appears once, at its first source', async () => {
		const c = await loadClean();
		expect(c.doc.content).toHaveLength(1);
		expect((await loadSync()).blocks.p2.cleanIds).toEqual([c.doc.content![0].attrs!.id]);
	});

	it('changing one source re-cleans every block that shares the clean block', async () => {
		await write([para('p1', 'یک'), para('p2', 'دو!'), para('p3', 'سه')]);
		await clean();
		expect(sentIds(mock)).toEqual(['p1', 'p2', 'p3']);
		expect((await loadClean()).doc.content![0].content![0].text).toBe('یک + دو! + سه');
	});

	it('deleting one source re-cleans the others', async () => {
		await write([para('p1', 'یک'), para('p3', 'سه')]);
		await clean();
		expect(sentIds(mock)).toEqual(['p1', 'p3']);
		expect((await loadClean()).doc.content![0].content![0].text).toBe('یک + سه');
	});
});

// ---- validation and retry ----------------------------------------------------------------------

describe('validation and retry', () => {
	it('retries once on invalid output and uses the second reply', async () => {
		mock = createMockProvider((req, i) => (i === 0 ? 'not json' : echo(req)));
		deps = { ...deps, provider: mock };
		await write([para('p1', 'یک')]);
		const r = await clean();
		expect(r).toMatchObject({ changed: true, modelCalls: 2, failed: [] });
		expect(mock.calls[1].messages.slice(2).map(m => m.role)).toEqual(['assistant', 'user']);
		expect(mock.calls[1].messages[3].content).toContain('not valid JSON');
	});

	it('after a second invalid reply leaves that batch untouched and reports it; other batches proceed', async () => {
		await write([para('p1', 'یک'), para('p2', 'دو'), para('p3', 'سه')]);
		await clean();
		const before = await loadClean();
		const syncBefore = await loadSync();

		mock = createMockProvider(req =>
			payload(req).blocks.some(b => b.id === 'p1')
				? JSON.stringify({ blocks: [{ type: 'paragraph', text: 'x', sources: ['zzz'] }] })
				: echo(req),
		);
		deps = { ...deps, provider: mock };
		await write([para('p1', 'یک تغییر'), para('p2', 'دو'), para('p3', 'سه تغییر')]);
		const r = await clean();
		expect(r.modelCalls).toBe(3);
		expect(r.failed).toEqual([{ blockIds: ['p1'], error: expect.stringContaining('zzz') }]);
		const after = await loadClean();
		expect(cleanFor(after, 'p1')).toEqual(cleanFor(before, 'p1'));
		expect((await loadSync()).blocks.p1).toEqual(syncBefore.blocks.p1);
		expect(cleanFor(after, 'p3')[0].content![0].text).toBe('پاک: سه تغییر');

		// The failed block is still pending: the next clean tries it again.
		mock = createMockProvider(echo);
		deps = { ...deps, provider: mock };
		await clean();
		expect(sentIds(mock)).toEqual(['p1']);
	});

	it('a failed batch of new blocks writes nothing when nothing else changed', async () => {
		mock = createMockProvider('{"blocks": []}');
		deps = { ...deps, provider: mock };
		await write([para('p1', 'یک')]);
		const r = await clean();
		expect(r).toMatchObject({ changed: false, modelCalls: 2, failed: [{ blockIds: ['p1'], error: 'no blocks' }] });
		expect(await vault.derived.loadClean(fileId)).toBeUndefined();
		expect(await vault.derived.listSnapshots(fileId)).toEqual([]);
	});

	it('a provider error aborts the run and writes nothing', async () => {
		await write([para('p1', 'یک')]);
		mock = createMockProvider(() => {
			throw new Error('network down');
		});
		deps = { ...deps, provider: mock };
		await expect(clean()).rejects.toThrow('network down');
		expect(await vault.derived.loadClean(fileId)).toBeUndefined();
		expect(await vault.derived.loadSync(fileId)).toBeUndefined();
	});
});

// ---- provenance (I4) ---------------------------------------------------------------------------

function textNodes(node: JSONNode): JSONNode[] {
	return typeof node.text === 'string' ? [node] : (node.content ?? []).flatMap(textNodes);
}

describe('provenance marks (I4)', () => {
	it('every text span of the clean doc is rewrite or aiAdded; gaps and additions are marked', async () => {
		mock = createMockProvider(req => {
			const [b] = payload(req).blocks;
			return JSON.stringify({
				blocks: [
					{ type: 'heading', level: 2, text: 'عنوان', sources: [b.id] },
					{ type: 'paragraph', text: `${b.text} <gap>نامعلوم</gap> و <ai>چند کلمه</ai>`, sources: [b.id] },
					{ type: 'bulletList', items: ['یک', 'دو <gap>؟</gap>'], sources: [b.id] },
					{ type: 'blockquote', text: 'نقل', sources: [b.id] },
				],
			});
		});
		deps = { ...deps, provider: mock };
		await write([para('p1', 'متن'), { type: 'codeBlock', attrs: { id: 'c1' }, content: [{ type: 'text', text: 'x' }] }]);
		await clean({ enrichment: 'light-add' });
		const nodes = (await loadClean()).doc.content!.flatMap(textNodes);
		expect(nodes.length).toBeGreaterThan(5);
		for (const n of nodes) {
			const types = n.marks!.map(m => m.type);
			expect(types.includes('rewrite') !== types.includes('aiAdded')).toBe(true);
		}
		const ai = nodes.filter(n => n.marks!.some(m => m.type === 'aiAdded'));
		expect(ai.map(n => n.text)).toEqual(['چند کلمه']);
		expect(ai[0].marks).toEqual([{ type: 'aiAdded', attrs: { accepted: false } }]);
		expect(nodes.filter(n => n.marks!.some(m => m.type === 'gap')).map(n => n.text)).toEqual(['نامعلوم', '؟']);
	});

	it('<ai> output is invalid unless enrichment is light-add', async () => {
		mock = createMockProvider(req =>
			JSON.stringify({ blocks: [{ type: 'paragraph', text: 'متن <ai>افزوده</ai>', sources: [payload(req).blocks[0].id] }] }),
		);
		deps = { ...deps, provider: mock };
		await write([para('p1', 'متن')]);
		const r = await clean({ enrichment: 'flag-gaps' });
		expect(r.failed).toHaveLength(1);
		expect(r.modelCalls).toBe(2);
	});
});

// ---- snapshot and undo -------------------------------------------------------------------------

describe('snapshot and undo', () => {
	const derivedFiles = async () => new Map([...(await files(root))].filter(([p]) => /^\.metis\/(clean|sync)\//.test(p)));

	it('undo restores the previous clean twin and sync state exactly', async () => {
		await write(day1());
		await clean();
		const before = await derivedFiles();
		const cleanBefore = await loadClean();
		const syncBefore = await loadSync();

		await write([...day1(), ...day2()]);
		await clean();
		expect(await vault.derived.listSnapshots(fileId)).toEqual([1, 2]);
		expect(await vault.derived.loadSnapshot(fileId, 2)).toEqual({ version: 1, clean: cleanBefore, sync: syncBefore });

		expect(await undoClean(vault.derived, fileId)).toBe(true);
		expect(await derivedFiles()).toEqual(before);
		expect(await loadClean()).toEqual(cleanBefore);
		expect(await loadSync()).toEqual(syncBefore);
		expect(await vault.derived.listSnapshots(fileId)).toEqual([1]);

		// After the undo, the next clean redoes day 2 only.
		mock.reset();
		await clean();
		expect(sentIds(mock)).toEqual(day2().map(b => b.attrs!.id));
	});

	it('undo of the first clean removes the clean twin and sync state', async () => {
		await write(day1());
		await clean();
		expect(await undoClean(vault.derived, fileId)).toBe(true);
		expect(await derivedFiles()).toEqual(new Map());
		expect(await undoClean(vault.derived, fileId)).toBe(false);
	});
});

// ---- I1: structural ----------------------------------------------------------------------------

describe('I1: clean code cannot write raw notes', () => {
	it('runs with a reader that exposes loadNote only and a derived store that exposes nothing else', async () => {
		await write(day1());
		const hashes = await rawHashes(root);
		const only = <T extends object>(target: T, allowed: string[]): T =>
			new Proxy(target, {
				get(t, key) {
					if (typeof key === 'string' && !allowed.includes(key)) throw new Error(`clean code touched ${key}`);
					return Reflect.get(t, key);
				},
			});
		const notes: RawNoteReader = only({ loadNote: (p: VaultPath) => vault.loadNote(p) }, ['loadNote']);
		const allowed: (keyof CleanDerivedStore)[] = [
			'loadSync', 'saveSync', 'deleteSync', 'loadClean', 'saveClean', 'deleteClean',
			'listSnapshots', 'loadSnapshot', 'saveSnapshot', 'deleteSnapshot',
		];
		const derived = only(vault.derived, allowed);
		await runClean({ notes, derived, provider: mock }, path, options);
		expect(await rawHashes(root)).toEqual(hashes);
		await write([...day1(), ...day2()]); // editor-side save
		const hashes2 = await rawHashes(root);
		await runClean({ notes, derived, provider: mock }, path, options);
		await undoClean(derived, fileId);
		expect(await rawHashes(root)).toEqual(hashes2);
		expect(mock.callCount).toBe(2);
	});

	it('clean and prompt sources never reference VaultStore or a note-writing API', () => {
		const src = join(import.meta.dirname, '..');
		const sources = ['clean', 'prompts'].flatMap(dir =>
			readdirSync(join(src, dir))
				.filter(f => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
				.map(f => ({ path: relative(src, join(src, dir, f)), text: readFileSync(join(src, dir, f), 'utf8') })),
		);
		expect(sources.length).toBeGreaterThan(3);
		for (const f of sources) {
			expect(f.text, f.path).not.toMatch(/\bVaultStore\b|saveNote|createNote|renameNote|createVault|openVault|\bDir\b/);
			for (const m of f.text.matchAll(/^import\s+(type\s+)?[^;]*?from\s+'([^']+)'/gm)) {
				if (/vault\//.test(m[2])) expect(m[1], `${f.path} imports ${m[2]} for values`).toBe('type ');
			}
		}
	});
});

// ---- diff unit ---------------------------------------------------------------------------------

describe('diffBlocks', () => {
	it('classifies new, changed, unchanged and deleted blocks and skips empty paragraphs', async () => {
		const first = await diffBlocks({ type: 'doc', content: [para('a', 'یک'), para('b', 'دو'), empty('e')] }, undefined);
		const sync: SyncState = {
			version: 1,
			revision: 1,
			blocks: Object.fromEntries(
				[...first.blocks, { id: 'gone', rawHash: 'x' }].map(b => [b.id, { rawHash: b.rawHash, cleanIds: [], lastRevision: 1 }]),
			),
		};
		const d = await diffBlocks({ type: 'doc', content: [para('b', 'دو!'), para('a', 'یک'), para('c', 'سه'), empty('e')] }, sync);
		expect(d.blocks.map(b => [b.id, b.kind])).toEqual([
			['b', 'changed'],
			['a', 'unchanged'],
			['c', 'new'],
		]);
		expect(d.deleted).toEqual(['gone']);
	});

	it('rejects raw blocks without an id or with a duplicate id', async () => {
		await expect(diffBlocks({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] }, undefined)).rejects.toThrow('without id');
		await expect(diffBlocks({ type: 'doc', content: [para('a', 'x'), para('a', 'y')] }, undefined)).rejects.toThrow('duplicate');
	});
});
