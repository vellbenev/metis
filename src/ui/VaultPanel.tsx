import { useEffect, useState, type FormEvent } from 'react';
import { hasFolderAccess, IdbVaults, pickFolderVault } from '../vault/backends';
import type { VaultPath, VaultStore } from '../vault/store';
import { FileTree, type FileTreeProps } from './FileTree';
import './vault.css';

export interface VaultPanelProps extends Omit<FileTreeProps, 'store' | 'onOpen'> {
	onOpen(store: VaultStore, path: VaultPath): void;
}

/** Chooses a vault (a folder on disk, or IndexedDB when folders are unavailable) and shows its tree. */
export function VaultPanel({ onOpen, ...treeProps }: VaultPanelProps) {
	const [store, setStore] = useState<VaultStore>();
	const [error, setError] = useState<string>();

	async function choose(load: () => Promise<VaultStore>) {
		setError(undefined);
		try {
			setStore(await load());
		} catch (e) {
			if (e instanceof DOMException && e.name === 'AbortError') return;
			setError(e instanceof Error ? e.message : String(e));
		}
	}

	if (store) return <FileTree store={store} onOpen={path => onOpen(store, path)} {...treeProps} />;

	return (
		<nav className='file-tree' aria-label='مخزن'>
			{hasFolderAccess() ? (
				<button type='button' className='vault-pick' onClick={() => choose(pickFolderVault)}>
					انتخاب پوشه‌ی مخزن
				</button>
			) : (
				<BrowserVaults onChoose={choose} />
			)}
			{error && (
				<p className='tree-error' role='alert'>
					{error}
				</p>
			)}
		</nav>
	);
}

function BrowserVaults({ onChoose }: { onChoose(load: () => Promise<VaultStore>): void }) {
	const [vaults, setVaults] = useState<IdbVaults>();
	const [names, setNames] = useState<string[]>([]);
	const [name, setName] = useState('');

	useEffect(() => {
		void IdbVaults.open().then(async v => {
			setVaults(v);
			setNames(await v.list());
		});
	}, []);

	if (!vaults) return null;
	const create = (e: FormEvent) => {
		e.preventDefault();
		if (name.trim()) onChoose(() => vaults.create(name));
	};
	return (
		<>
			<ul>
				{names.map(n => (
					<li key={n}>
						<button type='button' className='tree-note' onClick={() => onChoose(() => vaults.open(n))}>
							{n}
						</button>
					</li>
				))}
			</ul>
			<form className='tree-form' onSubmit={create}>
				<input
					aria-label='نام مخزن تازه'
					placeholder='مخزن تازه'
					value={name}
					onChange={e => setName(e.target.value)}
				/>
			</form>
		</>
	);
}
