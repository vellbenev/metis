// The three ways a vault can be stored: a real folder (File System Access API), IndexedDB, memory.

import { MemoryDir, type Dir } from './dir';
import { FsaDir, type FsaDirectoryHandle } from './fsaDir';
import { IdbDir, openVaultDb } from './idbDir';
import { createVault, fold, isVault, openVault, type VaultStore } from './store';

export function memoryVault(name: string): Promise<VaultStore> {
	return createVault(new MemoryDir(), name);
}

/** A vault is the chosen folder itself. Opens it, or turns it into a vault if it is not one yet. */
export async function folderVault(handle: FsaDirectoryHandle): Promise<VaultStore> {
	const root = new FsaDir(handle);
	return (await isVault(root)) ? openVault(root) : createVault(root, handle.name);
}

type PickerWindow = { showDirectoryPicker(options: { mode: 'readwrite' }): Promise<FsaDirectoryHandle> };

export function hasFolderAccess(): boolean {
	return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

export async function pickFolderVault(): Promise<VaultStore> {
	const handle = await (window as unknown as PickerWindow).showDirectoryPicker({ mode: 'readwrite' });
	return folderVault(handle);
}

/** Vaults kept in IndexedDB, one top-level directory per vault. */
export class IdbVaults {
	private constructor(private root: Dir) {}

	static async open(dbName?: string, factory?: IDBFactory): Promise<IdbVaults> {
		return new IdbVaults(new IdbDir(await openVaultDb(dbName, factory)));
	}

	async list(): Promise<string[]> {
		return (await this.root.list()).filter(e => e.kind === 'dir').map(e => e.name);
	}

	async create(name: string): Promise<VaultStore> {
		const key = name.trim().normalize('NFC');
		if ((await this.list()).some(n => fold(n) === fold(key)))
			throw new Error(`a vault named ${key} already exists`);
		return createVault((await this.root.getDir(key, { create: true }))!, key);
	}

	async open(name: string): Promise<VaultStore> {
		const dir = await this.root.getDir(name);
		if (!dir) throw new Error(`no vault named ${name}`);
		return openVault(dir);
	}
}
