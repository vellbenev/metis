// In-memory stand-in for the File System Access API handles that FsaDir uses.
// Mirrors the browser's errors: NotFoundError, TypeMismatchError, InvalidModificationError,
// the "write goes to a swap file, visible on close" behaviour of createWritable(),
// and optionally a case- and Unicode-form-insensitive file system like macOS APFS or Windows NTFS.

import type { FsaDirectoryHandle, FsaFileHandle } from '../vault/fsaDir';

const err = (name: string, message: string) => new DOMException(message, name);

function checkName(name: string): void {
	if (!name || name === '.' || name === '..' || /[/\\]/.test(name)) throw new TypeError(`invalid name: ${name}`);
}

class FakeFile implements FsaFileHandle {
	readonly kind = 'file';
	data = '';

	async getFile() {
		const text = this.data;
		return { text: async () => text };
	}

	async createWritable() {
		let swap = '';
		return {
			write: async (chunk: string) => {
				swap += chunk;
			},
			close: async () => {
				this.data = swap;
			},
		};
	}
}

export class FakeDirectoryHandle implements FsaDirectoryHandle {
	readonly kind = 'directory';
	// Keyed by the name as the file system compares it; the stored name is the one first created.
	private children = new Map<string, { name: string; handle: FakeFile | FakeDirectoryHandle }>();

	constructor(
		readonly name = 'root',
		private options: { caseInsensitive?: boolean } = {},
	) {}

	private key(name: string): string {
		checkName(name);
		return this.options.caseInsensitive ? name.normalize('NFC').toLowerCase() : name;
	}

	async getFileHandle(name: string, options: { create?: boolean } = {}): Promise<FsaFileHandle> {
		const key = this.key(name);
		const child = this.children.get(key)?.handle;
		if (child instanceof FakeDirectoryHandle) throw err('TypeMismatchError', name);
		if (child) return child;
		if (!options.create) throw err('NotFoundError', name);
		const file = new FakeFile();
		this.children.set(key, { name, handle: file });
		return file;
	}

	async getDirectoryHandle(name: string, options: { create?: boolean } = {}): Promise<FsaDirectoryHandle> {
		const key = this.key(name);
		const child = this.children.get(key)?.handle;
		if (child instanceof FakeFile) throw err('TypeMismatchError', name);
		if (child) return child;
		if (!options.create) throw err('NotFoundError', name);
		const dir = new FakeDirectoryHandle(name, this.options);
		this.children.set(key, { name, handle: dir });
		return dir;
	}

	async removeEntry(name: string, options: { recursive?: boolean } = {}): Promise<void> {
		const key = this.key(name);
		const child = this.children.get(key)?.handle;
		if (!child) throw err('NotFoundError', name);
		if (child instanceof FakeDirectoryHandle && child.children.size > 0 && !options.recursive) {
			throw err('InvalidModificationError', name);
		}
		this.children.delete(key);
	}

	async *entries(): AsyncIterableIterator<[string, FsaFileHandle | FsaDirectoryHandle]> {
		for (const { name, handle } of [...this.children.values()]) yield [name, handle];
	}
}
