import { EditorContent, useEditor } from '@tiptap/react';
import { useEffect, useState, type MouseEvent } from 'react';
import type { BlockRef } from './cleanView/model';
import { editorExtensions } from './editor/extensions';
import { rawBlockAt, setLinkedBlocks } from './editor/linkHighlight';
import { appSettingsStore, SettingsEntry } from './settings/SettingsEntry';
import { CleanButton } from './ui/CleanButton';
import { CleanPane } from './ui/CleanPane';
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
	const [fileId, setFileId] = useState<string>();
	// Block linking between the raw note and its clean twin (SPEC 9).
	const [selected, setSelected] = useState<BlockRef>();
	const [showClean, setShowClean] = useState(true);

	function selectRaw(e: MouseEvent) {
		const id = rawBlockAt(editor, e.target as Node);
		setSelected(id ? { side: 'raw', id } : undefined);
	}

	function linkRaw(ids: string[], scroll: boolean) {
		setLinkedBlocks(editor, ids);
		if (scroll && ids[0]) {
			editor.view.dom
				.querySelector(`[data-block-id="${CSS.escape(ids[0])}"]`)
				?.scrollIntoView?.({ block: 'nearest' });
		}
	}

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
					setFileId(session?.fileId);
					setSelected(undefined);
				}}
				beforeChange={() => session?.pause()}
				afterChange={() => session?.resume()}
				onMoved={async (from, to) => {
					await session?.moved(from, to);
					setActivePath(session?.path);
				}}
			/>
			<main className={vault && fileId && showClean && !textbook ? 'page wide' : 'page'}>
				<SettingsEntry />
				{textbook && (
					<>
						<button type='button' className='textbook-back' onClick={() => setTextbook(undefined)}>
							بازگشت به یادداشت
						</button>
						<TextbookView
							load={() => loadVaultTextbook(textbook.store)}
							report={textbook.report}
							version={textbook.version}
						/>
					</>
				)}
				<div hidden={!!textbook}>
					{vault && activePath && (
						<div className='note-bar'>
							<CleanButton
								run={async () => {
									await session?.flush(); // clean what is on screen
									const report = await cleanNote(
										vault,
										session?.path ?? activePath,
										appSettingsStore(),
									);
									setCleanCount(n => n + 1); // the textbook stale count may have changed
									return report;
								}}
							/>
							<button
								type='button'
								className='clean-toggle'
								aria-pressed={showClean}
								onClick={() => {
									setShowClean(v => !v);
									setSelected(undefined);
									setLinkedBlocks(editor, []);
								}}
							>
								{showClean ? 'پنهان کردن پاک‌نویس' : 'نمایش پاک‌نویس'}
							</button>
						</div>
					)}
					{saveError && (
						<p className='save-error' role='status'>
							ذخیره نشد؛ نوشته‌ها هنوز اینجا هستند و با ویرایش بعدی دوباره ذخیره می‌شوند. ({saveError})
						</p>
					)}
					<div className={vault && fileId && showClean ? 'parallel' : undefined}>
						<div className='raw-pane' onClick={selectRaw}>
							<EditorContent editor={editor} />
						</div>
						{vault && fileId && showClean && (
							<CleanPane
								derived={vault.derived}
								fileId={fileId}
								version={cleanCount}
								selected={selected}
								onSelect={setSelected}
								onLinkedRaw={linkRaw}
								onChanged={() => setCleanCount(n => n + 1)}
							/>
						)}
					</div>
				</div>
			</main>
		</div>
	);
}
