import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { TreeFolder, TreeItem, VaultPath, VaultStore } from '../vault/store';
import './vault.css';

export interface FileTreeProps {
	store: VaultStore;
	activePath?: VaultPath;
	onOpen(path: VaultPath): void;
	/** Called after a rename, so an open note can follow its file. */
	onMoved?(from: VaultPath, to: VaultPath): void | Promise<void>;
	/** Called before a rename, so pending edits can be saved first. */
	beforeChange?(): void | Promise<void>;
}

type Editing =
	| { mode: 'new-folder'; parent: VaultPath }
	| { mode: 'new-note'; parent: VaultPath }
	| { mode: 'rename'; item: TreeItem };

const same = (a?: VaultPath, b?: VaultPath) => !!a && !!b && a.length === b.length && a.every((n, i) => n === b[i]);
const key = (path: VaultPath) => path.join('/');

function NameInput(props: { initial: string; label: string; onSubmit(name: string): void; onCancel(): void }) {
	const [value, setValue] = useState(props.initial);
	const submit = (e: FormEvent) => {
		e.preventDefault();
		if (value.trim()) props.onSubmit(value);
		else props.onCancel();
	};
	return (
		<form className='tree-form' onSubmit={submit}>
			<input
				autoFocus
				aria-label={props.label}
				value={value}
				onChange={e => setValue(e.target.value)}
				onKeyDown={e => e.key === 'Escape' && props.onCancel()}
				onBlur={props.onCancel}
			/>
		</form>
	);
}

export function FileTree({ store, activePath, onOpen, onMoved, beforeChange }: FileTreeProps) {
	const [tree, setTree] = useState<TreeFolder>();
	const [editing, setEditing] = useState<Editing>();
	const [error, setError] = useState<string>();

	const refresh = useCallback(async () => setTree(await store.tree()), [store]);
	useEffect(() => {
		void refresh();
	}, [refresh]);

	async function run(action: () => Promise<void>) {
		setEditing(undefined);
		setError(undefined);
		try {
			await action();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
		await refresh();
	}

	function submit(name: string) {
		const current = editing;
		if (!current) return;
		void run(async () => {
			if (current.mode === 'new-folder') await store.createFolder(current.parent, name);
			else if (current.mode === 'new-note') {
				await store.createNote(current.parent, name);
				onOpen([...current.parent, name.trim()]);
			} else {
				await beforeChange?.();
				const { item } = current;
				const to =
					item.kind === 'folder'
						? await store.renameFolder(item.path, name)
						: await store.renameNote(item.path, name);
				await onMoved?.(item.path, to);
			}
		});
	}

	const input = (label: string, initial = '') => (
		<NameInput label={label} initial={initial} onSubmit={submit} onCancel={() => setEditing(undefined)} />
	);

	const actions = (parent: VaultPath) => (
		<span className='tree-actions'>
			<button type='button' title='پوشه‌ی تازه' onClick={() => setEditing({ mode: 'new-folder', parent })}>
				+پوشه
			</button>
			<button type='button' title='یادداشت تازه' onClick={() => setEditing({ mode: 'new-note', parent })}>
				+یادداشت
			</button>
		</span>
	);

	const pending = (parent: VaultPath) =>
		editing && editing.mode !== 'rename' && same(editing.parent, parent) ? (
			<li>{input(editing.mode === 'new-folder' ? 'نام پوشه' : 'نام یادداشت')}</li>
		) : null;

	function renderItem(item: TreeItem) {
		const renaming = editing?.mode === 'rename' && same(editing.item.path, item.path);
		const rename = () => setEditing({ mode: 'rename', item });
		if (item.kind === 'note') {
			return (
				<li key={key(item.path)}>
					{renaming ? (
						input('نام تازه', item.name)
					) : (
						<button
							type='button'
							className='tree-note'
							aria-current={same(item.path, activePath) ? 'page' : undefined}
							onClick={() => onOpen(item.path)}
							onDoubleClick={rename}
						>
							{item.name}
						</button>
					)}
				</li>
			);
		}
		return (
			<li key={key(item.path)}>
				<div className='tree-folder'>
					{renaming ? (
						input('نام تازه', item.name)
					) : (
						<span className='tree-name' onDoubleClick={rename}>
							{item.name}
						</span>
					)}
					{actions(item.path)}
				</div>
				<ul>
					{item.children.map(renderItem)}
					{pending(item.path)}
				</ul>
			</li>
		);
	}

	return (
		<nav className='file-tree' aria-label='یادداشت‌ها'>
			<div className='tree-folder tree-root'>
				<strong>{store.meta.name}</strong>
				{actions([])}
			</div>
			<ul>
				{tree?.children.map(renderItem)}
				{pending([])}
			</ul>
			{error && (
				<p className='tree-error' role='alert'>
					{error}
				</p>
			)}
			<p className='tree-hint'>برای تغییر نام، دو بار کلیک کنید.</p>
		</nav>
	);
}
