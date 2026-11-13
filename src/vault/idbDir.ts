// Dir backed by IndexedDB, the fallback when the File System Access API is missing.
// One object store holds every entry, keyed by its full path ("a/b/c"); names never contain "/".

import { segment, type Dir, type DirEntry } from './dir';

const STORE = 'entries';

type Entry = { kind: 'dir' } | { kind: 'file'; text: string };

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
	const open = factory.open(name, 1);
	open.onupgradeneeded = () => open.result.createObjectStore(STORE);
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

	private async get(key: string): Promise<Entry | undefined> {
		const tx = this.db.transaction(STORE, 'readonly');
		return request(tx.objectStore(STORE).get(key) as IDBRequest<Entry | undefined>);
	}

	async list(): Promise<DirEntry[]> {
		const tx = this.db.transaction(STORE, 'readonly');
		const store = tx.objectStore(STORE);
		const range = this.path ? below(this.path) : undefined;
		const [keys, values] = await Promise.all([
			request(store.getAllKeys(range)),
			request(store.getAll(range) as IDBRequest<Entry[]>),
		]);
		const prefix = this.path ? this.path.length + 1 : 0;
		const out: DirEntry[] = [];
		keys.forEach((key, i) => {
			const name = String(key).slice(prefix);
			if (!name.includes('/')) out.push({ name, kind: values[i].kind === 'dir' ? 'dir' : 'file' });
		});
		return out;
	}

	async readFile(name: string): Promise<string | undefined> {
		const entry = await this.get(this.key(name));
		if (entry?.kind === 'dir') throw new Error(`not a file: ${name}`);
		return entry?.text;
	}

	async writeFile(name: string, text: string): Promise<void> {
		const key = this.key(name);
		const tx = this.db.transaction(STORE, 'readwrite');
		const store = tx.objectStore(STORE);
		const existing = (await request(store.get(key))) as Entry | undefined;
		if (existing?.kind === 'dir') {
			tx.abort();
			throw new Error(`not a file: ${name}`);
		}
		store.put({ kind: 'file', text } satisfies Entry, key);
		await done(tx);
	}

	async getDir(name: string, options: { create?: boolean } = {}): Promise<Dir | undefined> {
		const key = this.key(name);
		const entry = await this.get(key);
		if (entry?.kind === 'file') throw new Error(`not a directory: ${name}`);
		if (!entry) {
			if (!options.create) return undefined;
			const tx = this.db.transaction(STORE, 'readwrite');
			tx.objectStore(STORE).put({ kind: 'dir' } satisfies Entry, key);
			await done(tx);
		}
		return new IdbDir(this.db, key);
	}

	async remove(name: string): Promise<void> {
		const key = this.key(name);
		const tx = this.db.transaction(STORE, 'readwrite');
		const store = tx.objectStore(STORE);
		store.delete(key);
		store.delete(below(key));
		await done(tx);
	}
}
