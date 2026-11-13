import { beforeEach, describe, expect, it } from 'vitest';
import { runClean, type CleanDeps } from '../clean/clean';
import type { CleanDerivedStore } from '../clean/ports';
import { aiSpans, collectGaps } from '../cleanView/model';
import { canonicalHash, type JSONNode } from '../core/blocks';
import { createMockProvider, type MockProvider } from '../provider/mock';
import type { ChatRequest } from '../provider/types';
import { loadFixture, textToDoc } from '../test/fixtures';
import { MemoryDir, type Dir } from '../vault/dir';
import { createVault, openVault, type VaultStore } from '../vault/store';
import { acceptAi, loadCleanView, removeAi, undoLastClean } from './cleanView';

/** A light-add model: each block becomes a paragraph with one aiAdded and one gap span. */
const model = (req: ChatRequest) =>
	JSON.stringify({
		blocks: JSON.parse(req.messages[1].content).blocks.map((b: { id: string; text: string }) => ({
			type: 'paragraph',
			text: `${b.text} <ai>افزوده</ai> و <gap>مبهم</gap>`,
			sources: [b.id],
		})),
	});

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

let root: MemoryDir;
let vault: VaultStore;
let fileId: string;
let mock: MockProvider;
let derived: CleanDerivedStore;
let deps: CleanDeps;

async function write(content: JSONNode[]) {
	const note = await vault.loadNote(['n']);
	await vault.saveNote(['n'], { ...note, doc: { type: 'doc', content } });
}
const clean = () => runClean(deps, ['n'], { rewriteLevel: 'structure', enrichment: 'light-add' });

beforeEach(async () => {
	root = new MemoryDir();
	vault = await createVault(root, 'ZKP');
	fileId = (await vault.createNote([], 'n')).fileId;
	mock = createMockProvider(model);
	derived = vault.derived;
	deps = { notes: { loadNote: p => vault.loadNote(p) }, derived, provider: mock };
	await write(lines('persian/zkp-01-basics.txt', 'a'));
	await clean();
});

describe('aiAdded accept / remove on the stored clean twin', () => {
	it('accept keeps the span with accepted: true and survives save/load', async () => {
		const spans = aiSpans((await loadCleanView(derived, fileId)).clean);
		expect(spans).toHaveLength(3);
		expect(await acceptAi(derived, fileId, spans[1].blockId, 0)).toBe(true);
		const reopened = await openVault(root);
		expect(aiSpans(await reopened.derived.loadClean(fileId)).map(s => s.accepted)).toEqual([false, true, false]);
	});

	it('remove deletes the span text and survives save/load', async () => {
		const spans = aiSpans((await loadCleanView(derived, fileId)).clean);
		expect(await removeAi(derived, fileId, spans[0].blockId, 0)).toBe(true);
		const reopened = await openVault(root);
		const after = aiSpans(await reopened.derived.loadClean(fileId));
		expect(after.map(s => s.blockId)).toEqual([spans[1].blockId, spans[2].blockId]);
		expect(JSON.stringify(await reopened.derived.loadClean(fileId))).not.toContain('افزوده و');
	});

	it('an unknown span changes nothing', async () => {
		const before = await derivedFiles(root, 'clean');
		expect(await acceptAi(derived, fileId, 'nope', 0)).toBe(false);
		expect(await removeAi(derived, fileId, 'nope', 0)).toBe(false);
		expect(await derivedFiles(root, 'clean')).toEqual(before);
	});

	it('I1: accept, remove and undo leave every raw note byte-identical', async () => {
		const hashes = await rawHashes(root);
		const spans = aiSpans((await loadCleanView(derived, fileId)).clean);
		await acceptAi(derived, fileId, spans[0].blockId, 0);
		await removeAi(derived, fileId, spans[1].blockId, 0);
		await undoLastClean(derived, fileId);
		expect(await rawHashes(root)).toEqual(hashes);
	});

	it('keeps the sync state byte-identical, writes no snapshot, and the next clean of unchanged raw makes no model call', async () => {
		const sync = await derivedFiles(root, 'sync');
		const history = await derivedFiles(root, 'history');
		const before = (await loadCleanView(derived, fileId)).clean!;
		const spans = aiSpans(before);
		await acceptAi(derived, fileId, spans[0].blockId, 0);
		await removeAi(derived, fileId, spans[2].blockId, 0);
		expect(await derivedFiles(root, 'sync')).toEqual(sync);
		expect(await derivedFiles(root, 'history')).toEqual(history);

		const edited = await derivedFiles(root, 'clean');
		const after = (await loadCleanView(derived, fileId)).clean!;
		expect(after.revision).toBe(before.revision);
		expect(after.doc.content!.map(b => b.attrs)).toEqual(before.doc.content!.map(b => b.attrs));

		mock.reset();
		expect(await clean()).toMatchObject({ changed: false, modelCalls: 0 });
		expect(await derivedFiles(root, 'clean')).toEqual(edited);
	});

	it('undo after accept/remove restores the snapshot of the last clean exactly (accepts made since are dropped)', async () => {
		await undoLastClean(derived, fileId);
		await clean();
		const derivedBefore = await derivedFiles(root, 'clean');
		await write([...lines('persian/zkp-01-basics.txt', 'a'), ...lines('persian/zkp-01-basics.day2.txt', 'b')]);
		await clean();
		const spans = aiSpans((await loadCleanView(derived, fileId)).clean);
		await acceptAi(derived, fileId, spans[0].blockId, 0);
		expect(await undoLastClean(derived, fileId)).toBe(true);
		expect(await derivedFiles(root, 'clean')).toEqual(derivedBefore);
	});
});

describe('undo of the last clean', () => {
	it('after clean then undo, the stored clean twin and sync state are byte-identical to before', async () => {
		const cleanBefore = await derivedFiles(root, 'clean');
		const syncBefore = await derivedFiles(root, 'sync');
		const historyBefore = await derivedFiles(root, 'history');
		expect(cleanBefore.size).toBe(1);
		expect(syncBefore.size).toBe(1);

		await write([...lines('persian/zkp-01-basics.txt', 'a'), ...lines('persian/zkp-01-basics.day2.txt', 'b')]);
		expect((await clean()).changed).toBe(true);
		expect(await derivedFiles(root, 'clean')).not.toEqual(cleanBefore);
		expect((await loadCleanView(derived, fileId)).canUndo).toBe(true);

		expect(await undoLastClean(derived, fileId)).toBe(true);
		expect(await derivedFiles(root, 'clean')).toEqual(cleanBefore);
		expect(await derivedFiles(root, 'sync')).toEqual(syncBefore);
		expect(await derivedFiles(root, 'history')).toEqual(historyBefore);
	});

	it('undo of the first clean removes the twin; nothing is left to undo', async () => {
		expect(await undoLastClean(derived, fileId)).toBe(true);
		expect(await loadCleanView(derived, fileId)).toEqual({ clean: undefined, canUndo: false });
		expect(await undoLastClean(derived, fileId)).toBe(false);
	});
});

describe('gap list follows the stored clean twin', () => {
	it('lists one gap per cleaned block and updates after an undo', async () => {
		expect(collectGaps((await loadCleanView(derived, fileId)).clean).map(g => g.text)).toEqual([
			'مبهم',
			'مبهم',
			'مبهم',
		]);
		await write([...lines('persian/zkp-01-basics.txt', 'a'), ...lines('persian/zkp-01-basics.day2.txt', 'b')]);
		await clean();
		expect(collectGaps((await loadCleanView(derived, fileId)).clean)).toHaveLength(
			3 + lines('persian/zkp-01-basics.day2.txt', 'b').length,
		);
		await undoLastClean(derived, fileId);
		expect(collectGaps((await loadCleanView(derived, fileId)).clean)).toHaveLength(3);
	});
});
