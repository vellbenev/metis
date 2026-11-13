// @vitest-environment jsdom
import { Editor } from '@tiptap/core';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, it } from 'vitest';
import { blockIds, type JSONNode } from '../core/blocks';
import { loadFixture, textToDoc } from '../test/fixtures';
import { editorExtensions } from './extensions';
import type { BlockIdsOptions } from './blockIds';

const editors: Editor[] = [];
afterEach(() => {
	while (editors.length) editors.pop()!.destroy();
});

function makeEditor(content: JSONNode | string, opts: Partial<BlockIdsOptions> = {}): Editor {
	const element = document.createElement('div');
	document.body.appendChild(element);
	const editor = new Editor({ element, extensions: editorExtensions(opts), content });
	editors.push(editor);
	return editor;
}

const ids = (editor: Editor) => blockIds(editor.getJSON() as JSONNode) as string[];
const texts = (editor: Editor) => {
	const out: string[] = [];
	editor.state.doc.forEach(n => out.push(n.textContent));
	return out;
};
/** Document position just inside the start of top-level block `index`. */
function blockStart(editor: Editor, index: number): number {
	let pos = 0;
	for (let i = 0; i < index; i++) pos += editor.state.doc.child(i).nodeSize;
	return pos + 1;
}
function blockOffset(editor: Editor, index: number): number {
	return blockStart(editor, index) - 1;
}

const p = (text: string, id?: string): JSONNode => ({
	type: 'paragraph',
	...(id ? { attrs: { id } } : {}),
	content: [{ type: 'text', text }],
});
const doc = (...content: JSONNode[]): JSONNode => ({ type: 'doc', content });

function expectValidIds(editor: Editor) {
	const all = ids(editor);
	for (const id of all) expect(id).toMatch(/^[A-Za-z0-9_-]{12}$/);
	expect(new Set(all).size).toBe(all.length);
}

describe('block ids: assignment', () => {
	it('gives every top-level block a nanoid(12) id on load', () => {
		const editor = makeEditor(doc(p('یک'), p('دو'), p('سه')));
		expectValidIds(editor);
		expect(ids(editor)).toHaveLength(3);
	});

	it('keeps existing ids on load', () => {
		const editor = makeEditor(doc(p('یک', 'aaaaaaaaaaaa'), p('دو', 'bbbbbbbbbbbb')));
		expect(ids(editor)).toEqual(['aaaaaaaaaaaa', 'bbbbbbbbbbbb']);
	});

	it('repairs duplicate ids on load: the first keeps it', () => {
		const editor = makeEditor(doc(p('یک', 'aaaaaaaaaaaa'), p('دو', 'aaaaaaaaaaaa')));
		expect(ids(editor)[0]).toBe('aaaaaaaaaaaa');
		expectValidIds(editor);
	});

	it('a list is one block: only the list carries an id, nested nodes do not', () => {
		const editor = makeEditor({
			type: 'doc',
			content: [
				{
					type: 'bulletList',
					content: [
						{ type: 'listItem', content: [p('الف', 'nestednested')] },
						{ type: 'listItem', content: [p('ب')] },
					],
				},
				{ type: 'blockquote', content: [p('نقل قول', 'nestedquote1')] },
				p('پایان'),
			],
		});
		expectValidIds(editor);
		expect(ids(editor)).toHaveLength(3);
		editor.state.doc.forEach(top =>
			top.descendants(node => {
				expect(node.attrs.id ?? null).toBeNull();
			}),
		);
	});

	it('strips the id of a block that becomes nested and gives the new list an id', () => {
		const editor = makeEditor(doc(p('یک', 'aaaaaaaaaaaa'), p('دو', 'bbbbbbbbbbbb')));
		editor.commands.setTextSelection(blockStart(editor, 1));
		editor.commands.toggleBulletList();
		expect(editor.state.doc.child(1).type.name).toBe('bulletList');
		expect(ids(editor)[0]).toBe('aaaaaaaaaaaa');
		expectValidIds(editor);
		editor.state.doc.child(1).descendants(node => {
			expect(node.attrs.id ?? null).toBeNull();
		});
	});

	it('assigns ids to fixture notes', () => {
		for (const name of ['zkp-01-basics.txt', 'zkp-01-basics.day2.txt', 'zkp-02-snark.txt']) {
			const source = textToDoc(loadFixture(`persian/${name}`));
			const editor = makeEditor(source);
			expect(ids(editor)).toHaveLength(source.content!.length);
			expectValidIds(editor);
			expect(texts(editor)).toEqual(source.content!.map(b => b.content![0].text));
		}
	});
});

describe('block ids: I2 operations', () => {
	it('edit keeps the id', () => {
		const editor = makeEditor(doc(p('می رود', 'aaaaaaaaaaaa'), p('دو', 'bbbbbbbbbbbb')));
		editor.chain().setTextSelection(blockStart(editor, 0) + 2).insertContent('‌ZKP ').run();
		editor.chain().setTextSelection({ from: blockStart(editor, 1), to: blockStart(editor, 1) + 2 }).deleteSelection().run();
		editor.chain().setTextSelection(blockStart(editor, 1)).insertContent('سه').run();
		expect(texts(editor)[0]).toContain('ZKP');
		expect(texts(editor)[1]).toBe('سه');
		expect(ids(editor)).toEqual(['aaaaaaaaaaaa', 'bbbbbbbbbbbb']);
	});

	it('changing block type keeps the id', () => {
		const editor = makeEditor(doc(p('عنوان', 'aaaaaaaaaaaa')));
		editor.chain().setTextSelection(blockStart(editor, 0)).setHeading({ level: 2 }).run();
		expect(editor.state.doc.child(0).type.name).toBe('heading');
		expect(ids(editor)[0]).toBe('aaaaaaaaaaaa');
	});

	it('split (Enter) keeps the id on the first part and mints a new id for the second', () => {
		const editor = makeEditor(doc(p('اولدوم', 'aaaaaaaaaaaa'), p('سه', 'cccccccccccc')));
		editor.commands.setTextSelection(blockStart(editor, 0) + 3);
		editor.commands.keyboardShortcut('Enter');
		expect(texts(editor)).toEqual(['اول', 'دوم', 'سه']);
		const [first, second, third] = ids(editor);
		expect(first).toBe('aaaaaaaaaaaa');
		expect(third).toBe('cccccccccccc');
		expect(second).not.toBe('aaaaaaaaaaaa');
		expectValidIds(editor);
	});

	it('split at the end of a block keeps the id on the first part', () => {
		const editor = makeEditor(doc(p('اول', 'aaaaaaaaaaaa')));
		editor.commands.setTextSelection(blockStart(editor, 0) + 3);
		editor.commands.keyboardShortcut('Enter');
		expect(ids(editor)[0]).toBe('aaaaaaaaaaaa');
		expect(ids(editor)).toHaveLength(2);
		expectValidIds(editor);
	});

	it('a raw ProseMirror split that copies attrs still leaves the id on the first part', () => {
		const editor = makeEditor(doc(p('اولدوم', 'aaaaaaaaaaaa')));
		editor.view.dispatch(editor.state.tr.split(blockStart(editor, 0) + 3));
		expect(ids(editor)[0]).toBe('aaaaaaaaaaaa');
		expectValidIds(editor);
	});

	it('merge (Backspace at block start) keeps the first block id', () => {
		const editor = makeEditor(doc(p('اول', 'aaaaaaaaaaaa'), p('دوم', 'bbbbbbbbbbbb'), p('سه', 'cccccccccccc')));
		editor.commands.setTextSelection(blockStart(editor, 1));
		editor.commands.keyboardShortcut('Backspace');
		expect(texts(editor)).toEqual(['اولدوم', 'سه']);
		expect(ids(editor)).toEqual(['aaaaaaaaaaaa', 'cccccccccccc']);
	});

	it('merge (Delete at block end) keeps the first block id', () => {
		const editor = makeEditor(doc(p('اول', 'aaaaaaaaaaaa'), p('دوم', 'bbbbbbbbbbbb')));
		editor.commands.setTextSelection(blockStart(editor, 0) + 3);
		editor.commands.keyboardShortcut('Delete');
		expect(texts(editor)).toEqual(['اولدوم']);
		expect(ids(editor)).toEqual(['aaaaaaaaaaaa']);
	});

	it('drag-move keeps the id', () => {
		const editor = makeEditor(doc(p('اول', 'aaaaaaaaaaaa'), p('دوم', 'bbbbbbbbbbbb'), p('سه', 'cccccccccccc')));
		const view = editor.view;
		// Drag block 0 and drop it after block 2, through ProseMirror's own drop handler.
		const sel = NodeSelection.create(editor.state.doc, blockOffset(editor, 0));
		view.dispatch(editor.state.tr.setSelection(sel));
		view.dragging = { slice: sel.content(), move: true, node: sel } as typeof view.dragging;
		const dropAt = editor.state.doc.content.size;
		view.posAtCoords = () => ({ pos: dropAt, inside: -1 });
		const event = new Event('drop', { bubbles: true, cancelable: true });
		Object.defineProperty(event, 'dataTransfer', { value: { getData: () => '', types: [] } });
		view.dom.dispatchEvent(event);
		expect(texts(editor)).toEqual(['دوم', 'سه', 'اول']);
		expect(ids(editor)).toEqual(['bbbbbbbbbbbb', 'cccccccccccc', 'aaaaaaaaaaaa']);
	});

	it('a move done as delete + insert in one transaction keeps the id', () => {
		const editor = makeEditor(doc(p('اول', 'aaaaaaaaaaaa'), p('دوم', 'bbbbbbbbbbbb')));
		const node = editor.state.doc.child(1);
		const tr = editor.state.tr.delete(blockOffset(editor, 1), editor.state.doc.content.size).insert(0, node);
		editor.view.dispatch(tr);
		expect(ids(editor)).toEqual(['bbbbbbbbbbbb', 'aaaaaaaaaaaa']);
	});

	it.each([
		['after', 3],
		['before', 0],
	])('copy-paste %s the originals mints new ids for the copies; originals keep theirs', (_, emptyIndex) => {
		const originals = [p('اول', 'aaaaaaaaaaaa'), p('دوم', 'bbbbbbbbbbbb'), p('سه', 'cccccccccccc')];
		const html = makeEditor(doc(...originals)).getHTML();
		expect(html).toContain('data-block-id="bbbbbbbbbbbb"');
		const content = [...originals];
		content.splice(emptyIndex, 0, { type: 'paragraph', attrs: { id: 'eeeeeeeeeeee' } });
		const editor = makeEditor(doc(...content));
		editor.commands.setTextSelection(blockStart(editor, emptyIndex));
		editor.view.pasteHTML(html, new Event('paste') as ClipboardEvent);

		const t = texts(editor).slice(0, 6);
		expect(t).toEqual(['اول', 'دوم', 'سه', 'اول', 'دوم', 'سه']);
		const all = ids(editor);
		const origStart = emptyIndex === 0 ? 3 : 0;
		const copyStart = emptyIndex === 0 ? 0 : 3;
		expect(all.slice(origStart, origStart + 3)).toEqual(['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc']);
		// The first copy merged into the empty block it was pasted into; the others are new blocks.
		expect(all[copyStart]).toBe('eeeeeeeeeeee');
		for (const id of all.slice(copyStart + 1, copyStart + 3)) {
			expect(['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc', 'eeeeeeeeeeee']).not.toContain(id);
		}
		expectValidIds(editor);
	});

	it('copy, delete the original, paste: the copy still gets a new id', () => {
		const editor = makeEditor(doc(p('اول', 'aaaaaaaaaaaa'), p('دوم', 'bbbbbbbbbbbb')));
		const html = editor.getHTML();
		editor.commands.setContent(doc(p('خالی', 'cccccccccccc')));
		editor.commands.setTextSelection(editor.state.doc.content.size - 1);
		editor.view.pasteHTML(html, new Event('paste') as ClipboardEvent);
		const all = ids(editor);
		expect(all).toContain('cccccccccccc');
		expect(all).not.toContain('aaaaaaaaaaaa');
		expect(all).not.toContain('bbbbbbbbbbbb');
		expectValidIds(editor);
	});

	it('a duplicated block inserted before the original: the original keeps the id', () => {
		const editor = makeEditor(doc(p('اول', 'aaaaaaaaaaaa'), p('دوم', 'bbbbbbbbbbbb')));
		const copy = editor.state.doc.child(1);
		editor.view.dispatch(editor.state.tr.insert(0, copy));
		const all = ids(editor);
		expect(all[2]).toBe('bbbbbbbbbbbb');
		expect(all[0]).not.toBe('bbbbbbbbbbbb');
		expectValidIds(editor);
	});

	it('save/load round trip preserves ids', () => {
		const editor = makeEditor(textToDoc(loadFixture('persian/zkp-02-snark.txt')));
		editor.commands.setTextSelection(blockStart(editor, 0) + 2);
		editor.commands.keyboardShortcut('Enter');
		const saved = JSON.stringify(editor.getJSON());
		const before = ids(editor);
		const reloaded = makeEditor(JSON.parse(saved));
		expect(ids(reloaded)).toEqual(before);
		expect(JSON.stringify(reloaded.getJSON())).toBe(saved);
	});

	it('undo of a split restores the original id layout', () => {
		const editor = makeEditor(doc(p('اولدوم', 'aaaaaaaaaaaa')));
		editor.commands.setTextSelection(blockStart(editor, 0) + 3);
		editor.commands.keyboardShortcut('Enter');
		editor.commands.undo();
		expect(ids(editor)).toEqual(['aaaaaaaaaaaa']);
	});
});

describe('block ids: never reused', () => {
	it('ids of deleted blocks are never minted again', () => {
		const queue = ['bbbbbbbbbbbb', 'aaaaaaaaaaaa', 'freshfresh01', 'freshfresh02'];
		const editor = makeEditor(doc(p('اول', 'aaaaaaaaaaaa'), p('دوم', 'bbbbbbbbbbbb')), {
			generateId: () => queue.shift() ?? 'zzzzzzzzzzzz',
		});
		// Delete block a entirely.
		editor.view.dispatch(editor.state.tr.delete(blockOffset(editor, 0), blockOffset(editor, 1)));
		expect(ids(editor)).toEqual(['bbbbbbbbbbbb']);
		// Split: the generator offers b (in use) and a (deleted) first; both must be skipped.
		editor.commands.setTextSelection(blockStart(editor, 0) + 1);
		editor.commands.keyboardShortcut('Enter');
		expect(ids(editor)).toEqual(['bbbbbbbbbbbb', 'freshfresh01']);
	});

	it('many splits never produce a repeated id', () => {
		const editor = makeEditor(doc(p('الف'.repeat(40))));
		const seen = new Set(ids(editor));
		for (let i = 0; i < 30; i++) {
			editor.commands.setTextSelection(blockStart(editor, 0) + 1);
			editor.commands.keyboardShortcut('Enter');
			const last = ids(editor)[1];
			expect(seen.has(last)).toBe(false);
			seen.add(last);
			// Delete the new block so its id is gone from the document.
			editor.view.dispatch(editor.state.tr.delete(blockOffset(editor, 1), blockOffset(editor, 2)));
		}
		expect(seen.size).toBe(31);
	});
});

describe('editor setup', () => {
	it('renders block ids as data attributes and keeps Persian text and ZWNJ intact', () => {
		const editor = makeEditor(doc(p('کتاب‌ها و zk-SNARK', 'aaaaaaaaaaaa')));
		expect(editor.getHTML()).toBe('<p data-block-id="aaaaaaaaaaaa">کتاب‌ها و zk-SNARK</p>');
		expect(editor.state.selection).toBeInstanceOf(TextSelection);
	});
});
