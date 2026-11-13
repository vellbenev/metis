import { EditorContent, useEditor } from '@tiptap/react';
import { editorExtensions } from './editor/extensions';
import { SettingsEntry } from './settings/SettingsEntry';

export function App() {
	const editor = useEditor({
		extensions: editorExtensions(),
		editorProps: { attributes: { dir: 'rtl', class: 'metis-editor' } },
	});

	return (
		<main className='page'>
			<SettingsEntry />
			<EditorContent editor={editor} />
		</main>
	);
}
