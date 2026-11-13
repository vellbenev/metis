// In-memory stand-in for the File System Access API handles that FsaDir uses.
// Mirrors the browser's errors: NotFoundError, TypeMismatchError, InvalidModificationError,
// and the "write goes to a swap file, visible on close" behaviour of createWritable().

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
	private children = new Map<string, FakeFile | FakeDirectoryHandle>();

	constructor(readonly name = 'root') {}

	async getFileHandle(name: string, options: { create?: boolean } = {}): Promise<FsaFileHandle> {
		checkName(name);
		let child = this.children.get(name);
		if (child instanceof FakeDirectoryHandle) throw err('TypeMismatchError', name);
		if (!child) {
			if (!options.create) throw err('NotFoundError', name);
			child = new FakeFile();
			this.children.set(name, child);
		}
		return child;
	}

	async getDirectoryHandle(name: string, options: { create?: boolean } = {}): Promise<FsaDirectoryHandle> {
		checkName(name);
		let child = this.children.get(name);
		if (child instanceof FakeFile) throw err('TypeMismatchError', name);
		if (!child) {
			if (!options.create) throw err('NotFoundError', name);
			child = new FakeDirectoryHandle(name);
			this.children.set(name, child);
		}
		return child;
	}

	async removeEntry(name: string, options: { recursive?: boolean } = {}): Promise<void> {
		checkName(name);
		const child = this.children.get(name);
		if (!child) throw err('NotFoundError', name);
		if (child instanceof FakeDirectoryHandle && child.children.size > 0 && !options.recursive) {
			throw err('InvalidModificationError', name);
		}
		this.children.delete(name);
	}

	async *entries(): AsyncIterableIterator<[string, FsaFileHandle | FsaDirectoryHandle]> {
		for (const entry of [...this.children]) yield entry;
	}
}
