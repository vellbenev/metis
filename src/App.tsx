import { EditorContent, useEditor } from '@tiptap/react';
import { useEffect, useState } from 'react';
import { editorExtensions } from './editor/extensions';
import { NoteSession } from './ui/noteSession';
import { VaultPanel } from './ui/VaultPanel';
import type { VaultPath } from './vault/store';

export function App() {
	const editor = useEditor({
		extensions: editorExtensions(),
		editable: false,
		editorProps: { attributes: { dir: 'rtl', class: 'metis-editor' } },
	});
	const [session, setSession] = useState<NoteSession>();
	const [activePath, setActivePath] = useState<VaultPath>();

	useEffect(() => {
		const s = new NoteSession(editor);
		setSession(s);
		return () => s.destroy();
	}, [editor]);

	return (
		<div className='shell'>
			<VaultPanel
				activePath={activePath}
				onOpen={async (store, path) => {
					await session?.open(store, path);
					editor.setEditable(true);
					setActivePath(session?.path);
				}}
				beforeChange={() => session?.flush()}
				onMoved={async (from, to) => {
					await session?.moved(from, to);
					setActivePath(session?.path);
				}}
			/>
			<main className='page'>
				<EditorContent editor={editor} />
			</main>
		</div>
	);
}
