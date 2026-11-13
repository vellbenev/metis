// Dir backed by the File System Access API.

import { segment, type Dir, type DirEntry } from './dir';

// The subset of the File System Access API that FsaDir uses.
export interface FsaFileHandle {
	kind: 'file';
	getFile(): Promise<{ text(): Promise<string> }>;
	createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
}

export interface FsaDirectoryHandle {
	kind: 'directory';
	name: string;
	getFileHandle(name: string, options?: { create?: boolean }): Promise<FsaFileHandle>;
	getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FsaDirectoryHandle>;
	removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
	entries(): AsyncIterable<[string, FsaFileHandle | FsaDirectoryHandle]>;
}

const isNotFound = (e: unknown) => e instanceof DOMException && e.name === 'NotFoundError';

export class FsaDir implements Dir {
	constructor(private handle: FsaDirectoryHandle) {}

	async list(): Promise<DirEntry[]> {
		const out: DirEntry[] = [];
		for await (const [name, h] of this.handle.entries()) {
			out.push({ name, kind: h.kind === 'directory' ? 'dir' : 'file' });
		}
		return out;
	}

	async readFile(name: string): Promise<string | undefined> {
		let file: FsaFileHandle;
		try {
			file = await this.handle.getFileHandle(segment(name));
		} catch (e) {
			if (isNotFound(e)) return undefined;
			throw e;
		}
		return (await file.getFile()).text();
	}

	async writeFile(name: string, text: string): Promise<void> {
		const file = await this.handle.getFileHandle(segment(name), { create: true });
		const writable = await file.createWritable();
		await writable.write(text);
		await writable.close();
	}

	async getDir(name: string, options: { create?: boolean } = {}): Promise<Dir | undefined> {
		try {
			return new FsaDir(await this.handle.getDirectoryHandle(segment(name), { create: options.create }));
		} catch (e) {
			if (isNotFound(e)) return undefined;
			throw e;
		}
	}

	async remove(name: string): Promise<void> {
		try {
			await this.handle.removeEntry(segment(name), { recursive: true });
		} catch (e) {
			if (!isNotFound(e)) throw e;
		}
	}
}
