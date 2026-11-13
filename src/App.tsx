import { EditorContent, useEditor } from '@tiptap/react';
import { useEffect, useState } from 'react';
import { editorExtensions } from './editor/extensions';
import { appSettingsStore, SettingsEntry } from './settings/SettingsEntry';
import { CleanButton } from './ui/CleanButton';
import { cleanNote } from './ui/cleanAction';
import { NoteSession } from './ui/noteSession';
import { TextbookControl } from './ui/TextbookControl';
import { TextbookView } from './ui/TextbookView';
import { buildVaultTextbook, loadVaultTextbook, undoVaultTextbook, vaultStaleCount } from './ui/textbookAction';
import type { TextbookReport } from './textbook/build';
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
	// The textbook view replaces the editor until the user goes back to the note.
	const [textbook, setTextbook] = useState<{ store: VaultStore; report?: TextbookReport; version: number }>();
	const [cleanCount, setCleanCount] = useState(0);

	useEffect(() => {
		const s = new NoteSession(editor, { onError: e => setSaveError(e?.message) });
		setSession(s);
		return () => s.destroy();
	}, [editor]);

	return (
		<div className='shell'>
			<VaultPanel
				activePath={activePath}
				aside={store => (
					<TextbookControl
						refreshKey={cleanCount}
						count={() => vaultStaleCount(store)}
						build={() => buildVaultTextbook(store, appSettingsStore())}
						undo={() => undoVaultTextbook(store)}
						onShow={report => setTextbook(t => ({ store, report, version: (t?.version ?? 0) + 1 }))}
					/>
				)}
				onOpen={async (store, path) => {
					try {
						await session?.open(store, path);
					} catch {
						return; // the save error is shown; stay on the current note
					}
					editor.setEditable(true);
					setTextbook(undefined);
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
				{textbook && (
					<>
						<button type='button' className='textbook-back' onClick={() => setTextbook(undefined)}>
							بازگشت به یادداشت
						</button>
						<TextbookView load={() => loadVaultTextbook(textbook.store)} report={textbook.report} version={textbook.version} />
					</>
				)}
				<div hidden={!!textbook}>
					{vault && activePath && (
						<CleanButton
							run={async () => {
								await session?.flush(); // clean what is on screen
								const report = await cleanNote(vault, session?.path ?? activePath, appSettingsStore());
								setCleanCount(n => n + 1); // the textbook stale count may have changed
								return report;
							}}
						/>
					)}
					{saveError && (
						<p className='save-error' role='status'>
							ذخیره نشد؛ نوشته‌ها هنوز اینجا هستند و با ویرایش بعدی دوباره ذخیره می‌شوند. ({saveError})
						</p>
					)}
					<EditorContent editor={editor} />
				</div>
			</main>
		</div>
	);
}
