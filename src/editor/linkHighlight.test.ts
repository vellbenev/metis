// @vitest-environment jsdom
import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JSONNode } from '../core/blocks';
import { editorExtensions } from './extensions';
import { rawBlockAt, setLinkedBlocks } from './linkHighlight';

let editor: Editor;
afterEach(() => editor.destroy());

const p = (id: string, text: string): JSONNode => ({
	type: 'paragraph',
	attrs: { id },
	content: [{ type: 'text', text }],
});

function make() {
	const element = document.createElement('div');
	document.body.appendChild(element);
	editor = new Editor({
		element,
		extensions: editorExtensions(),
		content: { type: 'doc', content: [p('r1', 'یک'), p('r2', 'دو'), p('r3', 'سه')] },
	});
	return editor;
}

const linked = () => [...editor.view.dom.querySelectorAll('.linked')].map(el => el.getAttribute('data-block-id'));

describe('raw-side link highlight', () => {
	it('decorates the linked raw blocks without changing the document or firing an update', () => {
		make();
		const before = JSON.stringify(editor.getJSON());
		const onUpdate = vi.fn();
		editor.on('update', onUpdate);

		setLinkedBlocks(editor, ['r1', 'r3']);
		expect(linked()).toEqual(['r1', 'r3']);
		setLinkedBlocks(editor, ['r2']);
		expect(linked()).toEqual(['r2']);
		setLinkedBlocks(editor, []);
		expect(linked()).toEqual([]);

		expect(onUpdate).not.toHaveBeenCalled();
		expect(JSON.stringify(editor.getJSON())).toBe(before);
		expect(editor.can().undo()).toBe(false);
	});

	it('finds the top-level raw block of a clicked DOM node', () => {
		make();
		const second = editor.view.dom.children[1];
		expect(rawBlockAt(editor, second.firstChild!)).toBe('r2');
		expect(rawBlockAt(editor, editor.view.dom)).toBeUndefined();
	});
});
