// @vitest-environment jsdom
import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import { blockIds, type JSONNode } from '../core/blocks';
import { editorExtensions } from '../editor/extensions';
import { loadFixture, textToDoc } from '../test/fixtures';
import { memoryVault } from '../vault/backends';
import { NoteSession } from './noteSession';

let editor: Editor;
afterEach(() => editor?.destroy());

async function setup() {
	editor = new Editor({ extensions: editorExtensions() });
	const store = await memoryVault('ZKP');
	await store.createFolder([], 'zkp');
	const note = await store.createNote(['zkp'], 'basics');
	const doc = textToDoc(loadFixture('persian/zkp-01-basics.txt'));
	doc.content = doc.content!.map((b, i) => ({ ...b, attrs: { id: `id${i}` } }));
	await store.saveNote(['zkp', 'basics'], { ...note, doc });
	await store.createNote(['zkp'], 'other');
	return { store, session: new NoteSession(editor, 10_000) };
}

describe('NoteSession', () => {
	it('loads a note into the editor without saving it', async () => {
		const { store, session } = await setup();
		const before = await store.loadNote(['zkp', 'basics']);
		await session.open(store, ['zkp', 'basics']);
		await session.flush();
		expect(editor.getJSON()).toEqual(before.doc);
		expect(await store.loadNote(['zkp', 'basics'])).toEqual(before);
	});

	it('saves edits back to the same file with block ids intact', async () => {
		const { store, session } = await setup();
		await session.open(store, ['zkp', 'basics']);
		editor.commands.insertContentAt(1, 'تازه ');
		await session.flush();
		const saved = await store.loadNote(['zkp', 'basics']);
		expect(saved.doc).toEqual(editor.getJSON());
		expect(blockIds(saved.doc)[0]).toBe('id0');
		expect((saved.doc.content![0].content![0] as JSONNode).text).toMatch(/^تازه /);
	});

	it('flushes pending edits before opening another note', async () => {
		const { store, session } = await setup();
		await session.open(store, ['zkp', 'basics']);
		editor.commands.insertContentAt(1, 'X');
		await session.open(store, ['zkp', 'other']);
		const basics = await store.loadNote(['zkp', 'basics']);
		expect((basics.doc.content![0].content![0] as JSONNode).text).toMatch(/^X/);
		expect(session.path).toEqual(['zkp', 'other']);
	});

	it('follows its note through a folder rename and keeps the new title', async () => {
		const { store, session } = await setup();
		await session.open(store, ['zkp', 'basics']);
		await session.flush();
		await store.renameNote(['zkp', 'basics'], 'مبانی');
		await session.moved(['zkp', 'basics'], ['zkp', 'مبانی']);
		await store.renameFolder(['zkp'], 'ZK');
		await session.moved(['zkp'], ['ZK']);
		editor.commands.insertContentAt(1, 'Y');
		await session.flush();
		const saved = await store.loadNote(['ZK', 'مبانی']);
		expect(saved.title).toBe('مبانی');
		expect((saved.doc.content![0].content![0] as JSONNode).text).toMatch(/^Y/);
		expect((await store.tree()).children.map(c => c.name)).toEqual(['ZK']);
	});
});
