import { EditorContent, useEditor } from '@tiptap/react';
import { useEffect, useState } from 'react';
import { editorExtensions } from './editor/extensions';
import { appSettingsStore, SettingsEntry } from './settings/SettingsEntry';
import { CleanButton } from './ui/CleanButton';
import { cleanNote } from './ui/cleanAction';
import { NoteSession } from './ui/noteSession';
import { VaultPanel } from './ui/VaultPanel';
import type { VaultPath, VaultStore } from './vault/store';

export function App() {
	const editor = useEditor({
		extensions: editorExtensions(),
		editable: false,
		editorProps: { attributes: { dir: 'rtl', class: 'metis-editor' } },
	});
	const [session, setSession] = useState<NoteSession>();
	const [activePath, setActivePath] = useState<VaultPath>();
	const [vault, setVault] = useState<VaultStore>();
	const [saveError, setSaveError] = useState<string>();

	useEffect(() => {
		const s = new NoteSession(editor, { onError: e => setSaveError(e?.message) });
		setSession(s);
		return () => s.destroy();
	}, [editor]);

	return (
		<div className='shell'>
			<VaultPanel
				activePath={activePath}
				onOpen={async (store, path) => {
					try {
						await session?.open(store, path);
					} catch {
						return; // the save error is shown; stay on the current note
					}
					editor.setEditable(true);
					setVault(store);
					setActivePath(session?.path);
				}}
				beforeChange={() => session?.pause()}
				afterChange={() => session?.resume()}
				onMoved={async (from, to) => {
					await session?.moved(from, to);
					setActivePath(session?.path);
				}}
			/>
			<main className='page'>
				<SettingsEntry />
				{vault && activePath && (
					<CleanButton
						run={async () => {
							await session?.flush(); // clean what is on screen
							return cleanNote(vault, session?.path ?? activePath, appSettingsStore());
						}}
					/>
				)}
				{saveError && (
					<p className='save-error' role='status'>
						ذخیره نشد؛ نوشته‌ها هنوز اینجا هستند و با ویرایش بعدی دوباره ذخیره می‌شوند. ({saveError})
					</p>
				)}
				<EditorContent editor={editor} />
			</main>
		</div>
	);
}
