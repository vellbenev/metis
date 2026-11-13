// Dir backed by IndexedDB, the fallback when the File System Access API is missing.
// Entries are keyed by their full path ("a/b/c"); names never contain "/".
// `entries` holds only the kind of each entry, so listing a directory never loads file text;
// `texts` holds the file contents under the same key.

import { segment, type Dir, type DirEntry } from './dir';

const ENTRIES = 'entries';
const TEXTS = 'texts';

type Kind = 'dir' | 'file';

function request<T>(r: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		r.onsuccess = () => resolve(r.result);
		r.onerror = () => reject(r.error);
	});
}

function done(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error);
	});
}

export function openVaultDb(name = 'metis-vaults', factory: IDBFactory = indexedDB): Promise<IDBDatabase> {
	const open = factory.open(name, 2);
	open.onupgradeneeded = () => {
		// Version 1 (text stored inline) never shipped in a release; start clean.
		for (const store of [...open.result.objectStoreNames]) open.result.deleteObjectStore(store);
		open.result.createObjectStore(ENTRIES);
		open.result.createObjectStore(TEXTS);
	};
	return request(open);
}

// "/" sorts just before "0", so [p + "/", p + "0") holds exactly the entries below p.
const below = (path: string) => IDBKeyRange.bound(`${path}/`, `${path}0`, false, true);

export class IdbDir implements Dir {
	/** `path` is "" for the root of the database. */
	constructor(
		private db: IDBDatabase,
		private path = '',
	) {}

	private key(name: string): string {
		segment(name);
		return this.path ? `${this.path}/${name}` : name;
	}

	private async kind(key: string): Promise<Kind | undefined> {
		const tx = this.db.transaction(ENTRIES, 'readonly');
		return request(tx.objectStore(ENTRIES).get(key) as IDBRequest<Kind | undefined>);
	}

	/** Direct children only: the cursor jumps over each child's descendants instead of reading them. */
	list(): Promise<DirEntry[]> {
		const tx = this.db.transaction(ENTRIES, 'readonly');
		const cursor = tx.objectStore(ENTRIES).openCursor(this.path ? below(this.path) : undefined);
		const prefix = this.path ? this.path.length + 1 : 0;
		const out: DirEntry[] = [];
		return new Promise((resolve, reject) => {
			cursor.onerror = () => reject(cursor.error);
			cursor.onsuccess = () => {
				const c = cursor.result;
				if (!c) return resolve(out);
				const key = String(c.key);
				const slash = key.indexOf('/', prefix);
				if (slash < 0) {
					out.push({ name: key.slice(prefix), kind: c.value as Kind });
					c.continue();
				} else {
					// A descendant of a child: skip the rest of that child's subtree.
					// (Siblings such as "a.json" sort between "a" and "a/...", so the jump happens here.)
					c.continue(`${key.slice(0, slash)}0`);
				}
			};
		});
	}

	async readFile(name: string): Promise<string | undefined> {
		const key = this.key(name);
		const tx = this.db.transaction([ENTRIES, TEXTS], 'readonly');
		const [kind, text] = await Promise.all([
			request(tx.objectStore(ENTRIES).get(key) as IDBRequest<Kind | undefined>),
			request(tx.objectStore(TEXTS).get(key) as IDBRequest<string | undefined>),
		]);
		if (kind === 'dir') throw new Error(`not a file: ${name}`);
		return kind === 'file' ? text : undefined;
	}

	async writeFile(name: string, text: string): Promise<void> {
		const key = this.key(name);
		const tx = this.db.transaction([ENTRIES, TEXTS], 'readwrite');
		const entries = tx.objectStore(ENTRIES);
		if ((await request(entries.get(key))) === 'dir') {
			tx.abort();
			throw new Error(`not a file: ${name}`);
		}
		entries.put('file' satisfies Kind, key);
		tx.objectStore(TEXTS).put(text, key);
		await done(tx);
	}

	async getDir(name: string, options: { create?: boolean } = {}): Promise<Dir | undefined> {
		const key = this.key(name);
		const kind = await this.kind(key);
		if (kind === 'file') throw new Error(`not a directory: ${name}`);
		if (!kind) {
			if (!options.create) return undefined;
			const tx = this.db.transaction(ENTRIES, 'readwrite');
			tx.objectStore(ENTRIES).put('dir' satisfies Kind, key);
			await done(tx);
		}
		return new IdbDir(this.db, key);
	}

	async remove(name: string): Promise<void> {
		const key = this.key(name);
		const tx = this.db.transaction([ENTRIES, TEXTS], 'readwrite');
		for (const store of [tx.objectStore(ENTRIES), tx.objectStore(TEXTS)]) {
			store.delete(key);
			store.delete(below(key));
		}
		await done(tx);
	}
}
