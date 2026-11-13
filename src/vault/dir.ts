// A minimal directory abstraction that every storage backend implements.
// A Dir only addresses its direct children by a single name; it can never reach its parent.

export interface DirEntry {
	name: string;
	kind: 'file' | 'dir';
}

export interface Dir {
	list(): Promise<DirEntry[]>;
	/** File text, or undefined if there is no such file. */
	readFile(name: string): Promise<string | undefined>;
	writeFile(name: string, text: string): Promise<void>;
	/** Child directory, or undefined if it does not exist and `create` is not set. */
	getDir(name: string, options?: { create?: boolean }): Promise<Dir | undefined>;
	/** Removes a file or a directory with everything in it. Missing entries are ignored. */
	remove(name: string): Promise<void>;
}

/** Throws unless `name` is exactly one path segment. Every backend calls this before touching storage. */
export function segment(name: string): string {
	if (
		typeof name !== 'string' ||
		name.length === 0 ||
		name === '.' ||
		name === '..' ||
		/[/\\\0]/.test(name)
	) {
		throw new Error(`invalid path segment: ${JSON.stringify(name)}`);
	}
	return name;
}

export class MemoryDir implements Dir {
	private files = new Map<string, string>();
	private dirs = new Map<string, MemoryDir>();

	async list(): Promise<DirEntry[]> {
		return [
			...[...this.dirs.keys()].map(name => ({ name, kind: 'dir' as const })),
			...[...this.files.keys()].map(name => ({ name, kind: 'file' as const })),
		];
	}

	async readFile(name: string): Promise<string | undefined> {
		segment(name);
		if (this.dirs.has(name)) throw new Error(`not a file: ${name}`);
		return this.files.get(name);
	}

	async writeFile(name: string, text: string): Promise<void> {
		segment(name);
		if (this.dirs.has(name)) throw new Error(`not a file: ${name}`);
		this.files.set(name, text);
	}

	async getDir(name: string, options: { create?: boolean } = {}): Promise<Dir | undefined> {
		segment(name);
		if (this.files.has(name)) throw new Error(`not a directory: ${name}`);
		let dir = this.dirs.get(name);
		if (!dir && options.create) {
			dir = new MemoryDir();
			this.dirs.set(name, dir);
		}
		return dir;
	}

	async remove(name: string): Promise<void> {
		segment(name);
		this.files.delete(name);
		this.dirs.delete(name);
	}
}

/** Resolves a chain of directory names below `dir`. */
export async function walk(dir: Dir, path: string[], create = false): Promise<Dir | undefined> {
	let current: Dir | undefined = dir;
	for (const name of path) {
		current = await current.getDir(name, { create });
		if (!current) return undefined;
	}
	return current;
}

/** Copies everything inside `from` into `to`. */
export async function copyInto(from: Dir, to: Dir): Promise<void> {
	for (const entry of await from.list()) {
		if (entry.kind === 'file') {
			await to.writeFile(entry.name, (await from.readFile(entry.name)) ?? '');
		} else {
			const src = await from.getDir(entry.name);
			const dst = await to.getDir(entry.name, { create: true });
			if (src && dst) await copyInto(src, dst);
		}
	}
}
