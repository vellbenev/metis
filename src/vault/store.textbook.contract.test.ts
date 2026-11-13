// Contract tests for the textbook part of the DerivedStore (S6), run against every backend.
// Kept apart from store.contract.test.ts so the two can change independently.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { FakeDirectoryHandle } from '../test/fakeFsa';
import { MemoryDir, type Dir } from './dir';
import { FsaDir } from './fsaDir';
import { IdbDir, openVaultDb } from './idbDir';
import { createVault } from './store';
import type { CleanNote, Textbook, TextbookOutline, TextbookSnapshot } from './types';

const backends: { name: string; emptyDir(): Promise<Dir> }[] = [
	{ name: 'memory', emptyDir: async () => new MemoryDir() },
	{ name: 'File System Access', emptyDir: async () => new FsaDir(new FakeDirectoryHandle('vault')) },
	{
		name: 'File System Access, case-insensitive',
		emptyDir: async () => new FsaDir(new FakeDirectoryHandle('vault', { caseInsensitive: true })),
	},
	{
		name: 'IndexedDB',
		emptyDir: async () => {
			const db = await openVaultDb('test', new IDBFactory());
			return (await new IdbDir(db).getDir('vault', { create: true }))!;
		},
	},
];

async function files(dir: Dir, prefix = ''): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	for (const entry of await dir.list()) {
		const path = prefix + entry.name;
		if (entry.kind === 'file') out.set(path, (await dir.readFile(entry.name))!);
		else for (const [p, t] of await files((await dir.getDir(entry.name))!, `${path}/`)) out.set(p, t);
	}
	return out;
}

const clean = (fileId: string): CleanNote => ({ version: 1, fileId, revision: 1, doc: { type: 'doc', content: [] } });
const outline: TextbookOutline = {
	version: 1,
	sections: [{ id: 's1', title: 'مقدمه‌ی zk-SNARK', sourceFileIds: ['f1'], order: 0 }],
};
const textbook: Textbook = {
	version: 1,
	builtAt: 1,
	sections: { s1: { doc: { type: 'doc', content: [] }, sourceRevisions: { f1: 1 } } },
	gaps: [],
};
const snap: TextbookSnapshot = { version: 1, outline, textbook };

describe.each(backends)('DerivedStore textbook contract: $name', ({ emptyDir }) => {
	const setup = async () => {
		const root = await emptyDir();
		return { root, store: await createVault(root, 'ZKP') };
	};

	it('lists the fileIds that have a clean twin', async () => {
		const { store } = await setup();
		expect(await store.derived.listCleanIds()).toEqual([]);
		await store.derived.saveClean(clean('f2'));
		await store.derived.saveClean(clean('f1'));
		await store.derived.saveSync('f3', { version: 1, revision: 1, blocks: {} });
		expect((await store.derived.listCleanIds()).sort()).toEqual(['f1', 'f2']);
		await store.derived.deleteClean('f2');
		expect(await store.derived.listCleanIds()).toEqual(['f1']);
	});

	it('round-trips textbook snapshots under .metis/textbook/history/ in numeric order', async () => {
		const { root, store } = await setup();
		const { derived } = store;
		expect(await derived.listTextbookSnapshots()).toEqual([]);
		expect(await derived.loadTextbookSnapshot(1)).toBeUndefined();
		await derived.saveTextbookSnapshot(10, snap);
		await derived.saveTextbookSnapshot(2, { version: 1, outline: null, textbook: null });
		expect(await derived.listTextbookSnapshots()).toEqual([2, 10]);
		expect(await derived.loadTextbookSnapshot(10)).toEqual(snap);
		const paths = [...(await files(root)).keys()].filter(p => p.startsWith('.metis/')).sort();
		expect(paths).toEqual(['.metis/textbook/history/10.json', '.metis/textbook/history/2.json']);
		await derived.deleteTextbookSnapshot(10);
		await derived.deleteTextbookSnapshot(99); // missing: no-op
		expect(await derived.listTextbookSnapshots()).toEqual([2]);
		for (const bad of [-1, 1.5, Number.NaN]) {
			await expect(derived.saveTextbookSnapshot(bad, snap)).rejects.toThrow();
		}
	});

	it('deletes the outline and the textbook; deleting a missing one is a no-op', async () => {
		const { root, store } = await setup();
		const { derived } = store;
		await derived.deleteOutline();
		await derived.deleteTextbook();
		await derived.saveOutline(outline);
		await derived.saveTextbook(textbook);
		await derived.deleteOutline();
		expect(await derived.loadOutline()).toBeUndefined();
		expect(await derived.loadTextbook()).toEqual(textbook);
		await derived.deleteTextbook();
		expect(await derived.loadTextbook()).toBeUndefined();
		expect([...(await files(root)).keys()].filter(p => p.startsWith('.metis/'))).toEqual([]);
	});

	it('never touches notes/**', async () => {
		const { root, store } = await setup();
		await store.createNote([], 'n');
		const before = [...(await files(root))].filter(([p]) => p.startsWith('notes/'));
		await store.derived.saveTextbookSnapshot(1, snap);
		await store.derived.deleteTextbookSnapshot(1);
		await store.derived.deleteOutline();
		await store.derived.deleteTextbook();
		await store.derived.listCleanIds();
		expect([...(await files(root))].filter(([p]) => p.startsWith('notes/'))).toEqual(before);
	});
});
