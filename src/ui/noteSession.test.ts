// @vitest-environment jsdom
import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
	const onError = vi.fn();
	return { store, onError, session: new NoteSession(editor, { delay: 10_000, onError }) };
}

const firstText = (doc: JSONNode) => (doc.content![0].content![0] as JSONNode).text;

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

	it('keeps edits after a failed save and saves them on the next try', async () => {
		const { store, session, onError } = await setup();
		await session.open(store, ['zkp', 'basics']);
		const save = vi.spyOn(store, 'saveNote').mockRejectedValueOnce(new Error('disk full'));
		editor.commands.insertContentAt(1, 'A');
		await expect(session.flush()).rejects.toThrow('disk full');
		expect(onError).toHaveBeenLastCalledWith(expect.objectContaining({ message: 'disk full' }));
		expect(firstText((await store.loadNote(['zkp', 'basics'])).doc)).not.toMatch(/^A/);

		// No new edit: the failed edits are still pending and the chain still works.
		await session.flush();
		expect(save).toHaveBeenCalledTimes(2);
		expect(onError).toHaveBeenLastCalledWith(undefined);
		expect(firstText((await store.loadNote(['zkp', 'basics'])).doc)).toMatch(/^A/);
	});

	it('refuses to switch notes while pending edits cannot be saved', async () => {
		const { store, session } = await setup();
		await session.open(store, ['zkp', 'basics']);
		vi.spyOn(store, 'saveNote').mockRejectedValueOnce(new Error('locked'));
		editor.commands.insertContentAt(1, 'B');
		await expect(session.open(store, ['zkp', 'other'])).rejects.toThrow('locked');
		expect(session.path).toEqual(['zkp', 'basics']);
		expect(firstText(editor.getJSON() as JSONNode)).toMatch(/^B/);
		await session.open(store, ['zkp', 'other']);
		expect(firstText((await store.loadNote(['zkp', 'basics'])).doc)).toMatch(/^B/);
	});

	it('the autosave timer saves on its own and its failure is reported, not thrown', async () => {
		vi.useFakeTimers();
		try {
			const { store, session, onError } = await setup();
			await session.open(store, ['zkp', 'basics']);
			vi.spyOn(store, 'saveNote').mockRejectedValueOnce(new Error('offline'));
			editor.commands.insertContentAt(1, 'C');
			await vi.advanceTimersByTimeAsync(10_000);
			expect(onError).toHaveBeenLastCalledWith(expect.objectContaining({ message: 'offline' }));
			editor.commands.insertContentAt(1, 'D');
			await vi.advanceTimersByTimeAsync(10_000);
			expect(firstText((await store.loadNote(['zkp', 'basics'])).doc)).toMatch(/^DC/);
		} finally {
			vi.useRealTimers();
		}
	});

	it('holds every save while paused, so a rename cannot be overwritten at the old path', async () => {
		const { store, session } = await setup();
		await session.open(store, ['zkp', 'basics']);
		editor.commands.insertContentAt(1, 'E');
		await session.pause(); // saves E first
		expect(firstText((await store.loadNote(['zkp', 'basics'])).doc)).toMatch(/^E/);

		editor.commands.insertContentAt(1, 'F');
		const pending = session.flush();
		await store.renameNote(['zkp', 'basics'], 'renamed');
		await new Promise(r => setTimeout(r, 0));
		await expect(store.loadNote(['zkp', 'basics'])).rejects.toThrow(); // nothing recreated the old file
		await session.moved(['zkp', 'basics'], ['zkp', 'renamed']);
		session.resume();
		await pending;
		expect(firstText((await store.loadNote(['zkp', 'renamed'])).doc)).toMatch(/^FE/);
		await expect(store.loadNote(['zkp', 'basics'])).rejects.toThrow();
	});
});
