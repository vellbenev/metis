// Highlights raw blocks linked to the selected clean block, as decorations only: the document is
// not touched, so no update event fires and nothing is saved.

import type { Editor } from '@tiptap/core';
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export const linkHighlightKey = new PluginKey<ReadonlySet<string>>('linkHighlight');

export const LinkHighlight = Extension.create({
	name: 'linkHighlight',
	addProseMirrorPlugins() {
		return [
			new Plugin<ReadonlySet<string>>({
				key: linkHighlightKey,
				state: {
					init: () => new Set(),
					apply: (tr, ids) => (tr.getMeta(linkHighlightKey) as ReadonlySet<string> | undefined) ?? ids,
				},
				props: {
					decorations(state) {
						const ids = linkHighlightKey.getState(state);
						if (!ids || ids.size === 0) return null;
						const decos: Decoration[] = [];
						state.doc.forEach((node, offset) => {
							if (ids.has(node.attrs.id))
								decos.push(Decoration.node(offset, offset + node.nodeSize, { class: 'linked' }));
						});
						return DecorationSet.create(state.doc, decos);
					},
				},
			}),
		];
	},
});

/** Sets the raw block ids to highlight. */
export function setLinkedBlocks(editor: Editor, ids: string[]): void {
	if (editor.isDestroyed) return;
	editor.view.dispatch(editor.state.tr.setMeta(linkHighlightKey, new Set(ids)).setMeta('addToHistory', false));
}

/** The id of the top-level raw block containing a DOM node inside the editor, if any. */
export function rawBlockAt(editor: Editor, target: Node): string | undefined {
	const root = editor.view.dom;
	let el: Node | null = target;
	while (el && el.parentNode !== root) el = el.parentNode;
	return el instanceof HTMLElement ? (el.getAttribute('data-block-id') ?? undefined) : undefined;
}
