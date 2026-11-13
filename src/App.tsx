import { EditorContent, useEditor } from '@tiptap/react';
import { editorExtensions } from './editor/extensions';

export function App() {
	const editor = useEditor({
		extensions: editorExtensions(),
		editorProps: { attributes: { dir: 'rtl', class: 'metis-editor' } },
	});

	return (
		<main className='page'>
			<EditorContent editor={editor} />
		</main>
	);
}
