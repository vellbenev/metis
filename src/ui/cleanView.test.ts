import { beforeEach, describe, expect, it } from 'vitest';
import { runClean, type CleanDeps } from '../clean/clean';
import type { CleanDerivedStore } from '../clean/ports';
import { aiSpans, collectGaps } from '../cleanView/model';
import { canonicalHash, type JSONNode } from '../core/blocks';
import { createMockProvider, type MockProvider } from '../provider/mock';
import type { ChatRequest } from '../provider/types';
import { createMemorySettingsStore, DEFAULT_SETTINGS } from '../settings/store';
import { loadFixture, textToDoc } from '../test/fixtures';
import { buildTextbook } from '../textbook/build';
import { textbookPorts } from '../textbook/ports';
import { MemoryDir, type Dir } from '../vault/dir';
import { createVault, openVault, type VaultStore } from '../vault/store';
import { cleanNote } from './cleanAction';
import { acceptAi, loadCleanView, removeAi, undoLastClean } from './cleanView';
import { vaultStaleCount } from './textbookAction';

/** A light-add model: each block becomes a paragraph with one aiAdded and one gap span. */
const cleanModel = (req: ChatRequest) =>
	JSON.stringify({
		blocks: JSON.parse(req.messages[1].content).blocks.map((b: { id: string; text: string }) => ({
			type: 'paragraph',
			text: `${b.text} <ai>افزوده</ai> و <gap>مبهم</gap>`,
			sources: [b.id],
		})),
	});

/** Textbook model: one section per file not yet in the outline; a section echoes its notes. */
const isOutline = (req: ChatRequest) => req.messages[0].content.includes('outline (table of contents)');
const textbookModel = createMockProvider(req => {
	const inp = JSON.parse(req.messages[1].content);
	if (isOutline(req)) {
		const assigned = new Set(inp.outline.flatMap((s: { files: string[] }) => s.files));
		return JSON.stringify({
			ops: inp.files
				.filter((f: { fileId: string }) => !assigned.has(f.fileId))
				.map((f: { fileId: string }) => ({ op: 'add', title: `بخش ${f.fileId}`, files: [f.fileId] })),
		});
	}
	return JSON.stringify({
		blocks: inp.files.flatMap((f: { text: string }) =>
			f.text.split('\n').map(line => ({ type: 'paragraph', text: line })),
		),
		gaps: [],
	});
});
const sectionCalls = () => textbookModel.calls.filter(c => !isOutline(c) && c.messages.length === 2);

async function files(dir: Dir, prefix = ''): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	for (const entry of await dir.list()) {
		const path = prefix + entry.name;
		if (entry.kind === 'file') out.set(path, (await dir.readFile(entry.name))!);
		else for (const [p, t] of await files((await dir.getDir(entry.name))!, `${path}/`)) out.set(p, t);
	}
	return out;
}

const rawHashes = async (root: Dir) =>
	new Map(
		await Promise.all(
			[...(await files(root))]
				.filter(([p]) => p.startsWith('notes/'))
				.map(async ([p, t]) => [p, await canonicalHash({ type: 'f', text: t })] as const),
		),
	);
const derivedFiles = async (root: Dir, kind: string) =>
	new Map([...(await files(root))].filter(([p]) => p.startsWith(`.metis/${kind}/`)));

const lines = (path: string, prefix: string): JSONNode[] =>
	textToDoc(loadFixture(path))
		.content!.slice(0, 3)
		.map((b, i) => ({ ...b, attrs: { id: `${prefix}${i}` } }));
const day1 = () => lines('persian/zkp-01-basics.txt', 'a');
const day2 = () => [...day1(), ...lines('persian/zkp-01-basics.day2.txt', 'b')];

let root: MemoryDir;
let vault: VaultStore;
let fileId: string;
let mock: MockProvider;
let derived: CleanDerivedStore;
let deps: CleanDeps;

async function write(content: JSONNode[], name = 'n') {
	const note = await vault.loadNote([name]);
	await vault.saveNote([name], { ...note, doc: { type: 'doc', content } });
}
const clean = (name = 'n') => runClean(deps, [name], { rewriteLevel: 'structure', enrichment: 'light-add' });
const current = async () => (await loadCleanView(derived, fileId)).clean!;
const build = () =>
	buildTextbook({ ...textbookPorts(vault.derived), provider: textbookModel }, { enrichment: 'flag-gaps' });

beforeEach(async () => {
	root = new MemoryDir();
	vault = await createVault(root, 'ZKP');
	fileId = (await vault.createNote([], 'n')).fileId;
	mock = createMockProvider(cleanModel);
	textbookModel.reset();
	derived = vault.derived;
	deps = { notes: { loadNote: p => vault.loadNote(p) }, derived, provider: mock };
	await write(day1());
	await clean();
});

describe('aiAdded accept / remove on the stored clean twin', () => {
	it('accept keeps the span with accepted: true, takes a new revision, and survives save/load', async () => {
		const spans = aiSpans(await current());
		expect(spans).toHaveLength(3);
		expect(await acceptAi(derived, fileId, 1, spans[1].blockId, 0)).toBe(true);
		const reopened = await openVault(root);
		const after = (await reopened.derived.loadClean(fileId))!;
		expect(aiSpans(after).map(s => s.accepted)).toEqual([false, true, false]);
		expect(after.revision).toBe(2);
		expect((await reopened.derived.loadSync(fileId))!.revision).toBe(2);
		expect(await reopened.derived.loadLastRevision(fileId)).toBe(2);
	});

	it('remove deletes the span text, takes a new revision, and survives save/load', async () => {
		const spans = aiSpans(await current());
		expect(await removeAi(derived, fileId, 1, spans[0].blockId, 0)).toBe(true);
		const reopened = await openVault(root);
		const after = (await reopened.derived.loadClean(fileId))!;
		expect(aiSpans(after).map(s => s.blockId)).toEqual([spans[1].blockId, spans[2].blockId]);
		expect(after.revision).toBe(2);
	});

	it('an unknown span or a twin that moved on since it was shown changes nothing', async () => {
		const before = await files(root);
		const spans = aiSpans(await current());
		expect(await acceptAi(derived, fileId, 1, 'nope', 0)).toBe(false);
		expect(await removeAi(derived, fileId, 1, 'nope', 0)).toBe(false);
		expect(await acceptAi(derived, fileId, 7, spans[0].blockId, 0)).toBe(false);
		expect(await undoLastClean(derived, fileId, 7)).toBe(false);
		expect(await files(root)).toEqual(before);
	});

	it('I1: accept, remove and undo leave every raw note byte-identical', async () => {
		const hashes = await rawHashes(root);
		let spans = aiSpans(await current());
		await acceptAi(derived, fileId, 1, spans[0].blockId, 0);
		spans = aiSpans(await current());
		await removeAi(derived, fileId, 2, spans[1].blockId, 0);
		await undoLastClean(derived, fileId, 3);
		await undoLastClean(derived, fileId, 2);
		expect(await rawHashes(root)).toEqual(hashes);
	});

	it('keeps ids, sources, changedIn and sync entries; the next clean of unchanged raw makes no model call', async () => {
		const before = await current();
		const syncBefore = (await derived.loadSync(fileId))!;
		const spans = aiSpans(before);
		await acceptAi(derived, fileId, 1, spans[0].blockId, 0);
		await removeAi(derived, fileId, 2, spans[2].blockId, 0);
		const after = await current();
		expect(after.doc.content!.map(b => b.attrs)).toEqual(before.doc.content!.map(b => b.attrs));
		expect(await derived.loadSync(fileId)).toEqual({ ...syncBefore, revision: 3 });

		const edited = await derivedFiles(root, 'clean');
		mock.reset();
		expect(await clean()).toMatchObject({ changed: false, modelCalls: 0 });
		expect(await derivedFiles(root, 'clean')).toEqual(edited);
	});

	it('undo after accept restores the twin and sync state from before the accept exactly', async () => {
		const cleanBefore = await derivedFiles(root, 'clean');
		const syncBefore = await derivedFiles(root, 'sync');
		const spans = aiSpans(await current());
		await acceptAi(derived, fileId, 1, spans[0].blockId, 0);
		expect(await undoLastClean(derived, fileId, 2)).toBe(true);
		expect(await derivedFiles(root, 'clean')).toEqual(cleanBefore);
		expect(await derivedFiles(root, 'sync')).toEqual(syncBefore);
	});
});

describe('undo and forward-only revisions', () => {
	it('after clean then undo, the stored clean twin and sync state are byte-identical to before', async () => {
		const cleanBefore = await derivedFiles(root, 'clean');
		const syncBefore = await derivedFiles(root, 'sync');
		const historyBefore = await derivedFiles(root, 'history');

		await write(day2());
		expect((await clean()).changed).toBe(true);
		expect(await derivedFiles(root, 'clean')).not.toEqual(cleanBefore);
		expect((await loadCleanView(derived, fileId)).canUndo).toBe(true);

		expect(await undoLastClean(derived, fileId, 2)).toBe(true);
		expect(await derivedFiles(root, 'clean')).toEqual(cleanBefore);
		expect(await derivedFiles(root, 'sync')).toEqual(syncBefore);
		expect(await derivedFiles(root, 'history')).toEqual(historyBefore);
	});

	it('the next clean after an undo never reuses a revision number, even after a reload', async () => {
		await write(day2());
		expect((await clean()).revision).toBe(2);
		await undoLastClean(derived, fileId, 2);
		expect((await current()).revision).toBe(1);

		vault = await openVault(root);
		derived = vault.derived;
		deps = { ...deps, derived };
		const r = await clean();
		expect(r).toMatchObject({ changed: true, revision: 3 });
		expect((await current()).revision).toBe(3);
		expect((await derived.loadSync(fileId))!.revision).toBe(3);
		expect(await derived.listSnapshots(fileId)).toEqual([1, 3]);

		// Undo of the first clean, then clean again: still forward.
		await undoLastClean(derived, fileId, 3);
		await undoLastClean(derived, fileId, 1);
		expect((await loadCleanView(derived, fileId)).clean).toBeUndefined();
		expect((await clean()).revision).toBe(4);
	});

	it('undo of the first clean removes the twin; nothing is left to undo', async () => {
		expect(await undoLastClean(derived, fileId, 1)).toBe(true);
		expect(await loadCleanView(derived, fileId)).toEqual({ clean: undefined, canUndo: false });
		expect(await undoLastClean(derived, fileId, undefined)).toBe(false);
	});
});

describe('textbook staleness follows every revision change', () => {
	let other: string;
	const sectionOf = async (id: string) =>
		(await vault.derived.loadOutline())!.sections.find(s => s.sourceFileIds.includes(id))!.title;

	beforeEach(async () => {
		other = (await vault.createNote([], 'm')).fileId;
		await write(lines('persian/zkp-01-basics.day2.txt', 'c'), 'm');
		await clean('m');
		await build();
		expect(await vaultStaleCount(vault)).toBe(0);
		textbookModel.reset();
	});

	it('undo makes the file stale; rebuilding regenerates only its section (I7)', async () => {
		await write(day2());
		await clean();
		await build();
		expect(await vaultStaleCount(vault)).toBe(0);
		textbookModel.reset();

		expect(await undoLastClean(derived, fileId, 2)).toBe(true);
		expect((await current()).revision).toBe(1);
		expect(await vaultStaleCount(vault)).toBe(1);
		await build();
		expect(sectionCalls().map(c => JSON.parse(c.messages[1].content).title)).toEqual([await sectionOf(fileId)]);
		expect(await vaultStaleCount(vault)).toBe(0);

		// The next clean takes a never-used revision: stale again, and only this file's section regenerates.
		textbookModel.reset();
		await write(day2());
		expect((await clean()).revision).toBe(3);
		expect(await vaultStaleCount(vault)).toBe(1);
		await build();
		expect(sectionCalls().map(c => JSON.parse(c.messages[1].content).title)).toEqual([await sectionOf(fileId)]);
		expect(await vaultStaleCount(vault)).toBe(0);
		expect(await sectionOf(other)).not.toBe(await sectionOf(fileId));
	});

	it('accept and remove make the file stale', async () => {
		const spans = aiSpans(await current());
		expect(await acceptAi(derived, fileId, 1, spans[0].blockId, 0)).toBe(true);
		expect(await vaultStaleCount(vault)).toBe(1);
		await build();
		expect(await vaultStaleCount(vault)).toBe(0);
		expect(await removeAi(derived, fileId, 2, spans[1].blockId, 0)).toBe(true);
		expect(await vaultStaleCount(vault)).toBe(1);
	});
});

describe('pane actions are serialised with a running clean', () => {
	it('an accept issued during a clean waits for it, then sees the newer twin and does nothing', async () => {
		let release!: () => void;
		const gate = new Promise<void>(r => (release = r));
		const slow = createMockProvider(async req => {
			await gate;
			return cleanModel(req);
		});
		const settings = createMemorySettingsStore({ ...DEFAULT_SETTINGS, enrichment: 'light-add' });
		const hashes = await rawHashes(root);
		await write(day2());
		const hashes2 = await rawHashes(root);
		expect(hashes2).not.toEqual(hashes);

		const cleaning = cleanNote(vault, ['n'], settings, () => slow);
		const spans = aiSpans(await current());
		const accepting = acceptAi(derived, fileId, 1, spans[0].blockId, 0);
		const undoing = undoLastClean(derived, fileId, 1);
		await new Promise(r => setTimeout(r, 0));
		expect((await current()).revision).toBe(1); // nothing written while the clean runs
		release();

		expect((await cleaning).revision).toBe(2);
		expect(await accepting).toBe(false);
		expect(await undoing).toBe(false);
		expect((await current()).revision).toBe(2);
		expect(aiSpans(await current()).every(s => !s.accepted)).toBe(true);
		expect(await rawHashes(root)).toEqual(hashes2);
	});
});

describe('gap list follows the stored clean twin', () => {
	it('lists one gap per cleaned block and updates after an undo', async () => {
		expect(collectGaps(await current()).map(g => g.text)).toEqual(['مبهم', 'مبهم', 'مبهم']);
		await write(day2());
		await clean();
		expect(collectGaps(await current())).toHaveLength(day2().length);
		await undoLastClean(derived, fileId, 2);
		expect(collectGaps(await current())).toHaveLength(3);
	});
});
