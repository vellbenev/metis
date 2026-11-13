import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { canonicalHash } from '../core/blocks';
import { FakeDirectoryHandle } from '../test/fakeFsa';
import { loadFixture, textToDoc } from '../test/fixtures';
import { folderVault, IdbVaults, memoryVault } from './backends';
import { MemoryDir, walk, type Dir } from './dir';
import { FsaDir } from './fsaDir';
import { IdbDir, openVaultDb } from './idbDir';
import { createDerivedStore, createVault, openVault, type VaultStore } from './store';
import type { CleanNote, HistorySnapshot, RawNote, SyncState, Textbook, TextbookOutline } from './types';

// One contract suite, run against every backend.
interface Backend {
	name: string;
	/** A fresh, empty directory to put a vault in. */
	emptyDir(): Promise<Dir>;
}

const backends: Backend[] = [
	{ name: 'memory', emptyDir: async () => new MemoryDir() },
	{ name: 'File System Access', emptyDir: async () => new FsaDir(new FakeDirectoryHandle('vault')) },
	{
		// macOS APFS and Windows NTFS: names differing only in case or Unicode form are the same entry.
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

/** Every file under `dir`, path -> text. */
async function files(dir: Dir, prefix = ''): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	for (const entry of await dir.list()) {
		const path = prefix + entry.name;
		if (entry.kind === 'file') out.set(path, (await dir.readFile(entry.name))!);
		else for (const [p, t] of await files((await dir.getDir(entry.name))!, `${path}/`)) out.set(p, t);
	}
	return out;
}

async function hashNotes(root: Dir): Promise<Map<string, string>> {
	const notes = await files((await root.getDir('notes'))!, 'notes/');
	const out = new Map<string, string>();
	for (const [path, text] of notes) out.set(path, await canonicalHash({ type: 'file', text }));
	return out;
}

const json = (text: string | undefined) => JSON.parse(text!);

function noteWithFixture(note: RawNote): RawNote {
	const doc = textToDoc(`${loadFixture('persian/zkp-01-basics.txt')}\nنیم‌فاصله در کتاب‌ها می‌ماند`);
	doc.content = doc.content!.map((block, i) => ({ ...block, attrs: { id: `blk${String(i).padStart(9, '0')}` } }));
	return { ...note, doc };
}

const sync = (revision: number): SyncState => ({
	version: 1,
	revision,
	blocks: { blk000000000: { rawHash: 'ab'.repeat(32), cleanIds: ['c1'], lastRevision: revision } },
});
const clean = (fileId: string, revision: number): CleanNote => ({
	version: 1,
	fileId,
	revision,
	doc: {
		type: 'doc',
		content: [
			{
				type: 'paragraph',
				attrs: { id: 'c1', sources: ['blk000000000'], changedIn: revision },
				content: [{ type: 'text', text: 'اثبات دانش‌صفر' }],
			},
		],
	},
});
const outline: TextbookOutline = {
	version: 1,
	sections: [{ id: 's1', title: 'مقدمه', sourceFileIds: ['f1'], order: 0 }],
};
const textbook: Textbook = {
	version: 1,
	builtAt: 1_700_000_000_000,
	sections: { s1: { doc: { type: 'doc', content: [] }, sourceRevisions: { f1: 2 } } },
	gaps: [{ sectionId: 's1', note: 'تعریف prover ناقص است' }],
};

/** Calls every derived-data write once with the given ids. */
async function writeAllDerived(store: VaultStore, fileId: string, rev = 1): Promise<void> {
	const { derived } = store;
	await derived.saveSync(fileId, sync(rev));
	await derived.saveClean(clean(fileId, rev));
	await derived.saveSnapshot(fileId, rev, { version: 1, clean: null, sync: null });
	await derived.saveOutline(outline);
	await derived.saveTextbook(textbook);
}

describe.each(backends)('VaultStore contract: $name', ({ emptyDir }) => {
	async function setup() {
		const root = await emptyDir();
		const store = await createVault(root, 'ZKP', 1234);
		return { root, store };
	}

	describe('Dir', () => {
		it('accepts only single path segments', async () => {
			const dir = await emptyDir();
			for (const bad of ['', '.', '..', 'a/b', '../notes', 'a\\b']) {
				await expect(dir.writeFile(bad, 'x'), bad).rejects.toThrow();
				await expect(dir.readFile(bad), bad).rejects.toThrow();
				await expect(dir.getDir(bad, { create: true }), bad).rejects.toThrow();
				await expect(dir.remove(bad), bad).rejects.toThrow();
			}
			expect(await dir.list()).toEqual([]);
		});

		it('lists a child folder and a sibling file whose name extends it', async () => {
			const dir = await emptyDir();
			const a = (await dir.getDir('a', { create: true }))!;
			await a.writeFile('inner.json', 'x');
			await dir.writeFile('a.json', 'y');
			await dir.writeFile('a-b', 'z');
			await dir.getDir('b', { create: true });
			const names = (await dir.list()).map(e => `${e.kind}:${e.name}`).sort();
			expect(names).toEqual(['dir:a', 'dir:b', 'file:a-b', 'file:a.json']);
			expect(await a.list()).toEqual([{ name: 'inner.json', kind: 'file' }]);
		});

		it('reads, writes, lists and removes', async () => {
			const dir = await emptyDir();
			expect(await dir.readFile('a.json')).toBeUndefined();
			expect(await dir.getDir('sub')).toBeUndefined();
			await dir.writeFile('a.json', 'یک');
			await dir.writeFile('a.json', 'دو');
			const sub = (await dir.getDir('sub', { create: true }))!;
			await sub.writeFile('b.json', 'b');
			await (await sub.getDir('deep', { create: true }))!.writeFile('c', 'c');
			expect(await dir.readFile('a.json')).toBe('دو');
			expect((await dir.list()).sort((x, y) => x.name.localeCompare(y.name))).toEqual([
				{ name: 'a.json', kind: 'file' },
				{ name: 'sub', kind: 'dir' },
			]);
			expect(await sub.list()).toHaveLength(2);
			await expect(dir.readFile('sub')).rejects.toThrow();
			await expect(dir.getDir('a.json')).rejects.toThrow();
			await dir.remove('sub');
			await dir.remove('missing');
			expect(await dir.list()).toEqual([{ name: 'a.json', kind: 'file' }]);
			const again = (await dir.getDir('sub', { create: true }))!;
			expect(await again.list()).toEqual([]);
		});
	});

	describe('vault', () => {
		it('creates metis.vault.json, notes/ and .metis/', async () => {
			const { root, store } = await setup();
			const meta = { version: 1, name: 'ZKP', createdAt: 1234, defaults: { rewriteLevel: 'structure' } };
			expect(json(await root.readFile('metis.vault.json'))).toEqual(meta);
			expect(store.meta).toEqual(meta);
			expect(await root.getDir('notes')).toBeDefined();
			expect(await root.getDir('.metis')).toBeDefined();
			expect((await openVault(root)).meta).toEqual(meta);
		});

		it('refuses to create over a vault or open a non-vault', async () => {
			const { root } = await setup();
			await expect(createVault(root, 'again')).rejects.toThrow();
			await expect(openVault(await emptyDir())).rejects.toThrow();
			await expect(createVault(await emptyDir(), '  ')).rejects.toThrow();
		});
	});

	describe('folders and notes', () => {
		it('lays files out as notes/<folder>/<file>.metis.json and lists them as a tree', async () => {
			const { root, store } = await setup();
			expect(await store.createFolder([], 'مبانی')).toEqual(['مبانی']);
			await store.createFolder([], 'الف');
			await store.createFolder(['مبانی'], 'زیرپوشه');
			const note = await store.createNote(['مبانی'], 'جلسه‌ی اول');
			await store.createNote(['مبانی'], 'zk-SNARK');
			await (await walk(root, ['notes', 'مبانی']))!.writeFile('readme.txt', 'not a note');

			const onDisk = json(await (await walk(root, ['notes', 'مبانی']))!.readFile('جلسه‌ی اول.metis.json'));
			expect(onDisk).toEqual(note);
			expect(note.version).toBe(1);
			expect(note.title).toBe('جلسه‌ی اول');
			expect(note.fileId).toMatch(/^[0-9a-f-]{36}$/);
			expect(note.doc.content![0].attrs!.id).toMatch(/^[\w-]{12}$/);

			const tree = await store.tree();
			expect(tree.children.map(c => [c.kind, c.name])).toEqual([
				['folder', 'الف'],
				['folder', 'مبانی'],
			]);
			const folder = tree.children[1];
			expect(folder.kind === 'folder' && folder.children.map(c => [c.kind, c.path])).toEqual([
				['folder', ['مبانی', 'زیرپوشه']],
				['note', ['مبانی', 'جلسه‌ی اول']],
				['note', ['مبانی', 'zk-SNARK']],
			]);
		});

		it('rejects duplicate, empty, hidden and path-like names', async () => {
			const { store } = await setup();
			await store.createFolder([], 'f');
			await store.createNote(['f'], 'n');
			await expect(store.createFolder([], 'f')).rejects.toThrow();
			await expect(store.createNote(['f'], 'n')).rejects.toThrow();
			for (const bad of ['', '  ', '.metis', '..', 'a/b', 'a\\b']) {
				await expect(store.createFolder([], bad), bad).rejects.toThrow();
				await expect(store.createNote(['f'], bad), bad).rejects.toThrow();
			}
			await expect(store.createNote(['missing'], 'x')).rejects.toThrow();
			await expect(store.createFolder(['..'], 'x')).rejects.toThrow();
		});

		it('saves and loads a RawNote unchanged, block ids included', async () => {
			const { store } = await setup();
			await store.createFolder([], 'zkp');
			const note = noteWithFixture(await store.createNote(['zkp'], 'basics'));
			await store.saveNote(['zkp', 'basics'], note);
			const loaded = await store.loadNote(['zkp', 'basics']);
			expect(loaded).toEqual(note);
			expect(loaded.doc.content!.map(b => b.attrs!.id)).toEqual(note.doc.content!.map(b => b.attrs!.id));
			expect(JSON.stringify(loaded)).toContain('‌'); // ZWNJ survives
			await expect(store.loadNote(['zkp', 'missing'])).rejects.toThrow();
			await expect(
				store.saveNote(['zkp', 'bad'], { ...note, version: 2 } as unknown as RawNote),
			).rejects.toThrow();
		});

		it('renames a note: new path, same fileId and content, old path gone', async () => {
			const { store } = await setup();
			await store.createFolder([], 'zkp');
			const note = noteWithFixture(await store.createNote(['zkp'], 'old'));
			await store.saveNote(['zkp', 'old'], note);
			await store.createNote(['zkp'], 'taken');
			await expect(store.renameNote(['zkp', 'old'], 'taken')).rejects.toThrow();

			expect(await store.renameNote(['zkp', 'old'], 'جدید')).toEqual(['zkp', 'جدید']);
			const moved = await store.loadNote(['zkp', 'جدید']);
			expect(moved).toEqual({ ...note, title: 'جدید' });
			await expect(store.loadNote(['zkp', 'old'])).rejects.toThrow();
		});

		it('renames a folder with everything inside it', async () => {
			const { store } = await setup();
			await store.createFolder([], 'a');
			await store.createFolder(['a'], 'inner');
			const note = await store.createNote(['a', 'inner'], 'n');
			await store.createFolder([], 'b');
			await expect(store.renameFolder(['a'], 'b')).rejects.toThrow();

			expect(await store.renameFolder(['a'], 'c')).toEqual(['c']);
			expect(await store.loadNote(['c', 'inner', 'n'])).toEqual(note);
			expect((await store.tree()).children.map(c => c.name)).toEqual(['b', 'c']);
		});
	});

	describe('names that a file system may treat as equal', () => {
		const composed = '\u0622ب'; // آب
		const decomposed = '\u0627\u0653ب'; // the same word, decomposed

		it('rejects creating a name that differs only in case or Unicode form', async () => {
			const { store } = await setup();
			await store.createFolder([], 'Foo');
			await store.createFolder([], composed);
			await store.createNote(['Foo'], 'Zk');
			await expect(store.createFolder([], 'foo')).rejects.toThrow(/already exists/);
			await expect(store.createFolder([], decomposed)).rejects.toThrow(/already exists/);
			await expect(store.createNote(['Foo'], 'zK')).rejects.toThrow(/already exists/);
			await store.createFolder([], 'Bar');
			await expect(store.renameFolder(['Bar'], 'FOO')).rejects.toThrow(/already exists/);
			expect((await store.loadNote(['Foo', 'Zk'])).title).toBe('Zk');
		});

		it('renames a note by case only without losing it', async () => {
			const { store } = await setup();
			await store.createFolder([], 'f');
			const note = noteWithFixture(await store.createNote(['f'], 'Zk'));
			await store.saveNote(['f', 'Zk'], note);
			expect(await store.renameNote(['f', 'Zk'], 'zk')).toEqual(['f', 'zk']);
			expect(await store.loadNote(['f', 'zk'])).toEqual({ ...note, title: 'zk' });
			const folder = (await store.tree()).children[0];
			expect(folder.kind === 'folder' && folder.children.map(c => c.name)).toEqual(['zk']);
		});

		it('renames a folder by case only without losing what is inside', async () => {
			const { store } = await setup();
			await store.createFolder([], 'Foo');
			await store.createFolder(['Foo'], 'inner');
			const a = await store.createNote(['Foo'], 'a');
			const b = await store.createNote(['Foo', 'inner'], 'b');
			expect(await store.renameFolder(['Foo'], 'foo')).toEqual(['foo']);
			expect(await store.loadNote(['foo', 'a'])).toEqual(a);
			expect(await store.loadNote(['foo', 'inner', 'b'])).toEqual(b);
			expect((await store.tree()).children.map(c => c.name)).toEqual(['foo']);
		});

		it('renames a decomposed Persian name to its composed form without losing it', async () => {
			const { root, store } = await setup();
			const note = await store.createNote([], 'x');
			// A file made outside Metis, with a decomposed name.
			const notes = (await root.getDir('notes'))!;
			await notes.writeFile(`${decomposed}.metis.json`, JSON.stringify({ ...note, fileId: 'other' }));
			await notes.getDir(decomposed, { create: true });
			await store.createNote([decomposed], 'inside');

			expect(await store.renameNote([decomposed], composed)).toEqual([composed]);
			expect((await store.loadNote([composed])).fileId).toBe('other');
			expect(await store.renameFolder([decomposed], composed)).toEqual([composed]);
			expect((await store.loadNote([composed, 'inside'])).title).toBe('inside');
			const names = (await store.tree()).children.map(c => c.name);
			expect(names.filter(n => n.normalize('NFC') === composed)).toHaveLength(2); // the folder and the note
			expect(names).not.toContain(decomposed);
		});

		it('keeps ZWNJ in folder and note names', async () => {
			const { store } = await setup();
			await store.createFolder([], 'درس‌ها');
			await store.createNote(['درس‌ها'], 'جلسه‌ی اول');
			await store.renameFolder(['درس‌ها'], 'کلاس‌ها');
			expect((await store.loadNote(['کلاس‌ها', 'جلسه‌ی اول'])).title).toBe('جلسه‌ی اول');
			expect((await store.tree()).children.map(c => c.name)).toEqual(['کلاس‌ها']);
		});
	});

	describe('interrupted case-only rename', () => {
		/** Wraps a Dir tree so that every write fails once something has been removed: a crash after remove(old). */
		function crashAfterRemove(dir: Dir, state = { removed: false }): Dir {
			const guard = () => {
				if (state.removed) throw new Error('crash');
			};
			return {
				list: () => dir.list(),
				readFile: name => dir.readFile(name),
				async writeFile(name, text) {
					guard();
					await dir.writeFile(name, text);
				},
				async getDir(name, options) {
					if (options?.create && !(await dir.getDir(name))) guard();
					const child = await dir.getDir(name, options);
					return child && crashAfterRemove(child, state);
				},
				async remove(name) {
					guard();
					await dir.remove(name);
					state.removed = true;
				},
			};
		}

		it('recovers a note when the vault is opened again', async () => {
			const root = await emptyDir();
			const setupStore = await createVault(root, 'ZKP');
			await setupStore.createFolder([], 'f');
			const note = noteWithFixture(await setupStore.createNote(['f'], 'Zk'));
			await setupStore.saveNote(['f', 'Zk'], note);

			const crashing = await openVault(crashAfterRemove(root));
			await expect(crashing.renameNote(['f', 'Zk'], 'zk')).rejects.toThrow('crash');

			const reopened = await openVault(root);
			expect(await reopened.loadNote(['f', 'zk'])).toEqual({ ...note, title: 'zk' });
			const folder = (await reopened.tree()).children[0];
			expect(folder.kind === 'folder' && folder.children.map(c => c.name)).toEqual(['zk']);
			expect((await (await walk(root, ['notes', 'f']))!.list()).map(e => e.name)).toEqual(['zk.metis.json']);
		});

		it('recovers a folder with everything inside it', async () => {
			const root = await emptyDir();
			const setupStore = await createVault(root, 'ZKP');
			await setupStore.createFolder([], 'Foo');
			await setupStore.createFolder(['Foo'], 'inner');
			const a = await setupStore.createNote(['Foo'], 'a');
			const b = await setupStore.createNote(['Foo', 'inner'], 'b');

			const crashing = await openVault(crashAfterRemove(root));
			await expect(crashing.renameFolder(['Foo'], 'foo')).rejects.toThrow('crash');

			const reopened = await openVault(root);
			expect(await reopened.loadNote(['foo', 'a'])).toEqual(a);
			expect(await reopened.loadNote(['foo', 'inner', 'b'])).toEqual(b);
			expect((await reopened.tree()).children.map(c => c.name)).toEqual(['foo']);
		});

		it('keeps a leftover visible under a new name when its target exists again', async () => {
			const { root, store } = await setup();
			const note = await store.createNote([], 'zk');
			const notes = (await root.getDir('notes'))!;
			const orphan = { ...note, fileId: 'orphan' };
			await notes.writeFile('.renaming.zk.metis.json', JSON.stringify(orphan));
			const reopened = await openVault(root);
			expect((await reopened.tree()).children.map(c => c.name)).toEqual(['zk', 'zk (recovered)']);
			expect(await reopened.loadNote(['zk'])).toEqual(note);
			expect((await reopened.loadNote(['zk (recovered)'])).fileId).toBe('orphan');
		});
	});

	describe('duplicate fileIds', () => {
		it('reports notes that share a fileId and deletes nothing', async () => {
			const { root, store } = await setup();
			await store.createFolder([], 'f');
			const note = await store.createNote(['f'], 'a');
			await store.createNote(['f'], 'other');
			expect(await store.duplicateFileIds()).toEqual([]);
			// As left behind by a crash between copy and delete.
			const f = (await walk(root, ['notes', 'f']))!;
			await f.writeFile('b.metis.json', (await f.readFile('a.metis.json'))!);
			expect(await store.duplicateFileIds()).toEqual([
				{
					fileId: note.fileId,
					paths: [
						['f', 'a'],
						['f', 'b'],
					],
				},
			]);
			expect(await store.loadNote(['f', 'a'])).toEqual(note);
			expect((await store.loadNote(['f', 'b'])).fileId).toBe(note.fileId);
		});
	});

	describe('derived data (.metis/)', () => {
		it('round-trips every derived type at the paths of SPEC section 5', async () => {
			const { root, store } = await setup();
			const { derived } = store;
			const id = 'f1';
			expect(await derived.loadSync(id)).toBeUndefined();
			expect(await derived.loadClean(id)).toBeUndefined();
			expect(await derived.loadSnapshot(id, 1)).toBeUndefined();
			expect(await derived.listSnapshots(id)).toEqual([]);
			expect(await derived.loadOutline()).toBeUndefined();
			expect(await derived.loadTextbook()).toBeUndefined();

			const snap: HistorySnapshot = { version: 1, clean: clean(id, 1), sync: sync(1) };
			await derived.saveSync(id, sync(2));
			await derived.saveClean(clean(id, 2));
			await derived.saveSnapshot(id, 10, snap);
			await derived.saveSnapshot(id, 2, { version: 1, clean: null, sync: null });
			await derived.saveOutline(outline);
			await derived.saveTextbook(textbook);

			expect(await derived.loadSync(id)).toEqual(sync(2));
			expect(await derived.loadClean(id)).toEqual(clean(id, 2));
			expect(await derived.loadSnapshot(id, 10)).toEqual(snap);
			expect(await derived.listSnapshots(id)).toEqual([2, 10]);
			expect(await derived.loadOutline()).toEqual(outline);
			expect(await derived.loadTextbook()).toEqual(textbook);

			expect([...(await files(root)).keys()].sort()).toEqual([
				'.metis/clean/f1.json',
				'.metis/history/f1/10.json',
				'.metis/history/f1/2.json',
				'.metis/sync/f1.json',
				'.metis/textbook/outline.json',
				'.metis/textbook/textbook.json',
				'metis.vault.json',
			]);
		});

		it('keeps derived data attached to a note across renames (keyed by fileId)', async () => {
			const { store } = await setup();
			await store.createFolder([], 'a');
			const note = await store.createNote(['a'], 'n');
			await store.derived.saveSync(note.fileId, sync(1));
			await store.renameNote(['a', 'n'], 'm');
			await store.renameFolder(['a'], 'b');
			const moved = await store.loadNote(['b', 'm']);
			expect(await store.derived.loadSync(moved.fileId)).toEqual(sync(1));
		});
	});

	describe('I1: derived-data code cannot write notes/**', () => {
		it('rejects fileIds and revisions that would leave its directory', async () => {
			const { store } = await setup();
			const { derived } = store;
			for (const bad of ['', '..', '../notes/x', 'a/b', '..\\notes', 'x.json', 'ﺍ']) {
				await expect(derived.saveSync(bad, sync(1)), bad).rejects.toThrow();
				await expect(derived.saveClean(clean(bad, 1)), bad).rejects.toThrow();
				await expect(
					derived.saveSnapshot(bad, 1, { version: 1, clean: null, sync: null }),
					bad,
				).rejects.toThrow();
				await expect(derived.loadSync(bad), bad).rejects.toThrow();
			}
			for (const bad of [-1, 1.5, Number.NaN]) {
				await expect(
					derived.saveSnapshot('f1', bad, { version: 1, clean: null, sync: null }),
				).rejects.toThrow();
			}
		});

		it('leaves every raw note byte-identical after all derived writes', async () => {
			const { root, store } = await setup();
			await store.createFolder([], 'zkp');
			const note = noteWithFixture(await store.createNote(['zkp'], 'basics'));
			await store.saveNote(['zkp', 'basics'], note);
			await store.createNote([], 'root-note');
			const before = await hashNotes(root);
			expect(before.size).toBe(2);

			await writeAllDerived(store, note.fileId, 1);
			await writeAllDerived(store, note.fileId, 2);
			await writeAllDerived(store, 'basics', 3); // a fileId equal to a note's file name
			await Promise.allSettled([
				store.derived.saveSync('../notes', sync(1)),
				store.derived.saveClean(clean('../notes/zkp/basics', 1)),
			]);

			expect(await hashNotes(root)).toEqual(before);
			const all = [...(await files(root)).keys()];
			expect(all.filter(p => p.startsWith('notes/')).sort()).toEqual([...before.keys()].sort());
		});

		it('a DerivedStore only ever touches the directory it was given', async () => {
			const root = await emptyDir();
			const notes = (await root.getDir('notes', { create: true }))!;
			await notes.writeFile('n.metis.json', '{}');
			const metis = (await root.getDir('.metis', { create: true }))!;
			const derived = createDerivedStore(metis);
			await derived.saveSync('f1', sync(1));
			await derived.saveTextbook(textbook);
			const paths = [...(await files(root)).keys()];
			expect(paths.filter(p => !p.startsWith('.metis/'))).toEqual(['notes/n.metis.json']);
			expect(await notes.readFile('n.metis.json')).toBe('{}');
		});
	});

	describe('I5: nothing secret goes into a vault', () => {
		it('refuses any write that carries an API key or similar secret', async () => {
			const { store } = await setup();
			await store.createFolder([], 'f');
			const note = await store.createNote(['f'], 'n');
			const leaky = { ...note, apiKey: 'sk-test' } as RawNote;
			await expect(store.saveNote(['f', 'n'], leaky)).rejects.toThrow(/secret/);
			const nested = { ...note, doc: { ...note.doc, attrs: { provider: { api_key: 'x' } } } };
			await expect(store.saveNote(['f', 'n'], nested)).rejects.toThrow(/secret/);
			await expect(
				store.derived.saveTextbook({ ...textbook, authorization: 'Bearer x' } as Textbook),
			).rejects.toThrow(/secret/);
			await expect(store.derived.saveSync('f1', { ...sync(1), password: 'x' } as SyncState)).rejects.toThrow();
			for (const key of ['openaiApiKey', 'x-api-key', 'token', 'apiKeys', 'refreshToken']) {
				await expect(store.saveNote(['f', 'n'], { ...note, [key]: 'x' }), key).rejects.toThrow(/secret/);
			}
			expect(await store.loadNote(['f', 'n'])).toEqual(note);
		});

		it('saves derived data whose ids happen to contain secret-like words', async () => {
			const { store } = await setup();
			const state: SyncState = {
				version: 1,
				revision: 1,
				blocks: { xTOKEN9ab_cd: { rawHash: 'ab', cleanIds: ['secret_abcde'], lastRevision: 1 } },
			};
			await store.derived.saveSync('f1', state);
			expect(await store.derived.loadSync('f1')).toEqual(state);
			const book: Textbook = {
				...textbook,
				sections: { 'access-tokens': { doc: { type: 'doc', content: [] }, sourceRevisions: { f1: 1 } } },
			};
			await store.derived.saveTextbook(book);
			expect(await store.derived.loadTextbook()).toEqual(book);
		});

		it('a full workflow leaves no secret-looking key in any vault file', async () => {
			const { root, store } = await setup();
			await store.createFolder([], 'f');
			const note = noteWithFixture(await store.createNote(['f'], 'n'));
			await store.saveNote(['f', 'n'], note);
			await writeAllDerived(store, note.fileId);
			for (const [path, text] of await files(root)) {
				expect(text, path).not.toMatch(
					/"[^"]*(api[-_]?key|password|authorization|secret|token|bearer)[^"]*":/i,
				);
			}
		});
	});
});

describe('backends', () => {
	it('IndexedDB list() never reads file contents', async () => {
		const db = await openVaultDb('list-test', new IDBFactory());
		const dir = (await new IdbDir(db).getDir('v', { create: true }))!;
		await dir.writeFile('big.json', 'x'.repeat(10_000));
		const transaction = vi.spyOn(db, 'transaction');
		expect(await dir.list()).toEqual([{ name: 'big.json', kind: 'file' }]);
		expect(transaction.mock.calls.map(c => c[0])).toEqual(['entries']);
	});

	it('memoryVault creates an empty vault', async () => {
		const store = await memoryVault('ZKP');
		expect(store.meta.name).toBe('ZKP');
		expect((await store.tree()).children).toEqual([]);
	});

	it('folderVault turns a chosen folder into a vault and reopens it', async () => {
		const handle = new FakeDirectoryHandle('ZKP');
		const created = await folderVault(handle);
		await created.createFolder([], 'a');
		const reopened = await folderVault(handle);
		expect(reopened.meta).toEqual(created.meta);
		expect((await reopened.tree()).children.map(c => c.name)).toEqual(['a']);
	});

	it('IdbVaults keeps several vaults apart and reopens them', async () => {
		const factory = new IDBFactory();
		const vaults = await IdbVaults.open('metis-test', factory);
		const a = await vaults.create('ZKP');
		await vaults.create('رمزنگاری');
		await a.createFolder([], 'only-in-zkp');
		await expect(vaults.create('ZKP')).rejects.toThrow();
		await expect(vaults.open('missing')).rejects.toThrow();

		const again = await IdbVaults.open('metis-test', factory);
		expect((await again.list()).sort()).toEqual(['ZKP', 'رمزنگاری'].sort());
		expect((await (await again.open('ZKP')).tree()).children.map(c => c.name)).toEqual(['only-in-zkp']);
		expect((await (await again.open('رمزنگاری')).tree()).children).toEqual([]);
	});
});
