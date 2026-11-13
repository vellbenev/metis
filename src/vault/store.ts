// VaultStore: the on-disk layout of SPEC section 5 on top of any Dir backend.
//
// I1: derived data lives in a DerivedStore that is built from the `.metis` directory alone. It holds
// no reference to the vault root or to `notes/`, and a Dir can only address its own children by a
// single validated name, so derived-data code has no way to reach `notes/**`.

import { nanoid } from 'nanoid';
import { copyInto, segment, walk, type Dir } from './dir';
import { assertNoSecrets } from './secrets';
import type { CleanNote, HistorySnapshot, RawNote, SyncState, Textbook, TextbookOutline, VaultMeta } from './types';

export const META_FILE = 'metis.vault.json';
export const NOTES_DIR = 'notes';
export const DERIVED_DIR = '.metis';
export const NOTE_EXT = '.metis.json';

/** Folder names below `notes/`, then the note name (without extension) for a note. */
export type VaultPath = string[];

export interface TreeNote {
	kind: 'note';
	name: string;
	path: VaultPath;
}
export interface TreeFolder {
	kind: 'folder';
	name: string;
	path: VaultPath;
	children: TreeItem[];
}
export type TreeItem = TreeNote | TreeFolder;

/** Read-only access to raw notes, for code that must never write them (clean, textbook, export). */
export interface NoteReader {
	tree(): Promise<TreeFolder>;
	loadNote(path: VaultPath): Promise<RawNote>;
	/** Notes that share a fileId (e.g. after a crash during a rename). Reported, never fixed silently. */
	duplicateFileIds(): Promise<{ fileId: string; paths: VaultPath[] }[]>;
}

export interface DerivedStore {
	loadSync(fileId: string): Promise<SyncState | undefined>;
	saveSync(fileId: string, state: SyncState): Promise<void>;
	loadClean(fileId: string): Promise<CleanNote | undefined>;
	saveClean(note: CleanNote): Promise<void>;
	listSnapshots(fileId: string): Promise<number[]>;
	loadSnapshot(fileId: string, revision: number): Promise<HistorySnapshot | undefined>;
	saveSnapshot(fileId: string, revision: number, snapshot: HistorySnapshot): Promise<void>;
	loadOutline(): Promise<TextbookOutline | undefined>;
	saveOutline(outline: TextbookOutline): Promise<void>;
	loadTextbook(): Promise<Textbook | undefined>;
	saveTextbook(textbook: Textbook): Promise<void>;
}

export interface VaultStore extends NoteReader {
	readonly meta: VaultMeta;
	readonly derived: DerivedStore;
	createFolder(parent: VaultPath, name: string): Promise<VaultPath>;
	renameFolder(path: VaultPath, name: string): Promise<VaultPath>;
	createNote(folder: VaultPath, name: string): Promise<RawNote>;
	renameNote(path: VaultPath, name: string): Promise<VaultPath>;
	/** Editor-side save of a raw note. The only code path that writes under `notes/`. */
	saveNote(path: VaultPath, note: RawNote): Promise<void>;
}

// ---- JSON helpers --------------------------------------------------------------------------

async function readJson<T>(dir: Dir, name: string): Promise<T | undefined> {
	const text = await dir.readFile(name);
	return text === undefined ? undefined : (JSON.parse(text) as T);
}

async function writeJson(dir: Dir, name: string, value: unknown): Promise<void> {
	assertNoSecrets(value);
	await dir.writeFile(name, `${JSON.stringify(value, null, '\t')}\n`);
}

/** A user-visible folder or note name. Leading dots are reserved (e.g. `.metis`). */
function userName(name: string): string {
	const trimmed = typeof name === 'string' ? name.trim().normalize('NFC') : '';
	segment(trimmed);
	if (trimmed.startsWith('.')) throw new Error(`names may not start with ".": ${JSON.stringify(name)}`);
	return trimmed;
}

/** How file systems may compare names: case-insensitive (APFS, NTFS) and Unicode-form-insensitive. */
export function fold(name: string): string {
	return name.normalize('NFC').toLowerCase();
}

const tempName = () => `.renaming-${nanoid(8)}`;

function fileId(id: string): string {
	if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
		throw new Error(`invalid fileId: ${JSON.stringify(id)}`);
	}
	return id;
}

function revision(rev: number): number {
	if (!Number.isSafeInteger(rev) || rev < 0) throw new Error(`invalid revision: ${rev}`);
	return rev;
}

function checkRawNote(note: RawNote): void {
	if (
		note?.version !== 1 ||
		typeof note.title !== 'string' ||
		note.doc?.type !== 'doc' ||
		(note.doc.content !== undefined && !Array.isArray(note.doc.content))
	) {
		throw new Error('invalid RawNote');
	}
	fileId(note.fileId);
}

// ---- Derived data (.metis/) ----------------------------------------------------------------

export function createDerivedStore(metis: Dir): DerivedStore {
	const sub = (name: string) => metis.getDir(name, { create: true }) as Promise<Dir>;
	const file = (id: string) => `${fileId(id)}.json`;
	const historyDir = async (id: string, create: boolean) => {
		const history = await metis.getDir('history', { create });
		return history?.getDir(fileId(id), { create });
	};

	return {
		loadSync: async id => readJson(await sub('sync'), file(id)),
		saveSync: async (id, state) => writeJson(await sub('sync'), file(id), state),
		loadClean: async id => readJson(await sub('clean'), file(id)),
		saveClean: async note => writeJson(await sub('clean'), file(note.fileId), note),
		async listSnapshots(id) {
			const dir = await historyDir(id, false);
			if (!dir) return [];
			return (await dir.list())
				.map(e => /^(\d+)\.json$/.exec(e.name)?.[1])
				.filter((n): n is string => n !== undefined)
				.map(Number)
				.sort((a, b) => a - b);
		},
		async loadSnapshot(id, rev) {
			const dir = await historyDir(id, false);
			return dir && readJson(dir, `${revision(rev)}.json`);
		},
		async saveSnapshot(id, rev, snapshot) {
			const name = `${revision(rev)}.json`;
			await writeJson((await historyDir(id, true))!, name, snapshot);
		},
		loadOutline: async () => readJson(await sub('textbook'), 'outline.json'),
		saveOutline: async outline => writeJson(await sub('textbook'), 'outline.json', outline),
		loadTextbook: async () => readJson(await sub('textbook'), 'textbook.json'),
		saveTextbook: async textbook => writeJson(await sub('textbook'), 'textbook.json', textbook),
	};
}

// ---- Vault ---------------------------------------------------------------------------------

function sortItems(items: TreeItem[]): TreeItem[] {
	return items.sort((a, b) =>
		a.kind !== b.kind ? (a.kind === 'folder' ? -1 : 1) : a.name.localeCompare(b.name, 'fa'),
	);
}

async function buildTree(dir: Dir, name: string, path: VaultPath): Promise<TreeFolder> {
	const children: TreeItem[] = [];
	for (const entry of await dir.list()) {
		if (entry.name.startsWith('.')) continue; // hidden, e.g. a rename in progress
		if (entry.kind === 'dir') {
			const sub = await dir.getDir(entry.name);
			if (sub) children.push(await buildTree(sub, entry.name, [...path, entry.name]));
		} else if (entry.name.endsWith(NOTE_EXT) && entry.name.length > NOTE_EXT.length) {
			const noteName = entry.name.slice(0, -NOTE_EXT.length);
			children.push({ kind: 'note', name: noteName, path: [...path, noteName] });
		}
	}
	return { kind: 'folder', name, path, children: sortItems(children) };
}

class DirVaultStore implements VaultStore {
	readonly derived: DerivedStore;

	constructor(
		readonly meta: VaultMeta,
		private notes: Dir,
		metis: Dir,
	) {
		this.derived = createDerivedStore(metis);
	}

	private async folder(path: VaultPath): Promise<Dir> {
		const dir = await walk(this.notes, path.map(segment));
		if (!dir) throw new Error(`no such folder: ${path.join('/')}`);
		return dir;
	}

	private async split(path: VaultPath): Promise<[Dir, string]> {
		if (path.length === 0) throw new Error('empty path');
		return [await this.folder(path.slice(0, -1)), path[path.length - 1]];
	}

	/** Name of an entry other than `except` that the file system would treat as `name`. */
	private async clash(dir: Dir, name: string, except?: string): Promise<string | undefined> {
		const want = fold(name);
		return (await dir.list()).find(e => e.name !== except && fold(e.name) === want)?.name;
	}

	private async refuseClash(dir: Dir, name: string, except?: string): Promise<void> {
		const other = await this.clash(dir, name, except);
		if (other !== undefined) throw new Error(`already exists: ${other}`);
	}

	tree(): Promise<TreeFolder> {
		return buildTree(this.notes, '', []);
	}

	async duplicateFileIds(): Promise<{ fileId: string; paths: VaultPath[] }[]> {
		const byId = new Map<string, VaultPath[]>();
		const visit = async (item: TreeItem): Promise<void> => {
			if (item.kind === 'folder') {
				for (const child of item.children) await visit(child);
				return;
			}
			let id: string;
			try {
				id = (await this.loadNote(item.path)).fileId;
			} catch {
				return;
			}
			byId.set(id, [...(byId.get(id) ?? []), item.path]);
		};
		await visit(await this.tree());
		return [...byId].filter(([, paths]) => paths.length > 1).map(([fileId, paths]) => ({ fileId, paths }));
	}

	async createFolder(parent: VaultPath, name: string): Promise<VaultPath> {
		const dir = await this.folder(parent);
		const clean = userName(name);
		await this.refuseClash(dir, clean);
		await dir.getDir(clean, { create: true });
		return [...parent, clean];
	}

	async renameFolder(path: VaultPath, name: string): Promise<VaultPath> {
		const [parent, old] = await this.split(path);
		const from = await parent.getDir(segment(old));
		if (!from) throw new Error(`no such folder: ${path.join('/')}`);
		const clean = userName(name);
		if (clean === old) return path;
		await this.refuseClash(parent, clean, old);
		if (fold(clean) === fold(old)) {
			// Case or Unicode-form change only: on a case-insensitive file system the old and new
			// names are the same entry, so go through a hidden temporary folder.
			const temp = tempName();
			await copyInto(from, (await parent.getDir(temp, { create: true }))!);
			await parent.remove(old);
			await copyInto((await parent.getDir(temp))!, (await parent.getDir(clean, { create: true }))!);
			await parent.remove(temp);
		} else {
			await copyInto(from, (await parent.getDir(clean, { create: true }))!);
			await parent.remove(old);
		}
		return [...path.slice(0, -1), clean];
	}

	async createNote(folder: VaultPath, name: string): Promise<RawNote> {
		const dir = await this.folder(folder);
		const clean = userName(name);
		await this.refuseClash(dir, clean + NOTE_EXT);
		const note: RawNote = {
			version: 1,
			fileId: crypto.randomUUID(),
			title: clean,
			doc: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: nanoid(12) } }] },
		};
		await writeJson(dir, clean + NOTE_EXT, note);
		return note;
	}

	async renameNote(path: VaultPath, name: string): Promise<VaultPath> {
		const [dir, old] = await this.split(path);
		const clean = userName(name);
		if (clean === old) return path;
		await this.refuseClash(dir, clean + NOTE_EXT, old + NOTE_EXT);
		const note = await this.loadNote(path);
		// The fileId stays, so derived data under .metis/ keeps pointing at this note.
		const renamed = { ...note, title: clean };
		if (fold(clean) === fold(old)) {
			// Same entry on a case-insensitive file system: keep a hidden copy until the new name is written.
			const temp = tempName();
			await writeJson(dir, temp, renamed);
			await dir.remove(old + NOTE_EXT);
			await writeJson(dir, clean + NOTE_EXT, renamed);
			await dir.remove(temp);
		} else {
			await writeJson(dir, clean + NOTE_EXT, renamed);
			await dir.remove(old + NOTE_EXT);
		}
		return [...path.slice(0, -1), clean];
	}

	async loadNote(path: VaultPath): Promise<RawNote> {
		const [dir, name] = await this.split(path);
		const note = await readJson<RawNote>(dir, segment(name) + NOTE_EXT);
		if (!note) throw new Error(`no such note: ${path.join('/')}`);
		checkRawNote(note);
		return note;
	}

	async saveNote(path: VaultPath, note: RawNote): Promise<void> {
		checkRawNote(note);
		const [dir, name] = await this.split(path);
		await writeJson(dir, segment(name) + NOTE_EXT, note);
	}
}

function checkMeta(meta: VaultMeta | undefined): VaultMeta {
	if (meta?.version !== 1 || typeof meta.name !== 'string') throw new Error(`not a Metis vault (${META_FILE})`);
	return meta;
}

/** Turns an empty directory into a vault. */
export async function createVault(root: Dir, name: string, now = Date.now()): Promise<VaultStore> {
	if ((await root.readFile(META_FILE)) !== undefined) throw new Error('a vault already exists here');
	const meta: VaultMeta = {
		version: 1,
		name: name.trim(),
		createdAt: now,
		defaults: { rewriteLevel: 'structure' },
	};
	if (!meta.name) throw new Error('vault name is empty');
	await writeJson(root, META_FILE, meta);
	return openVault(root);
}

export async function openVault(root: Dir): Promise<VaultStore> {
	const meta = checkMeta(await readJson<VaultMeta>(root, META_FILE));
	const notes = (await root.getDir(NOTES_DIR, { create: true }))!;
	const metis = (await root.getDir(DERIVED_DIR, { create: true }))!;
	return new DirVaultStore(meta, notes, metis);
}

export async function isVault(root: Dir): Promise<boolean> {
	return (await root.readFile(META_FILE)) !== undefined;
}
