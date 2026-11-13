// Plain-text views of blocks for the clean prompt.

import type { JSONNode } from '../core/blocks';

const hasMark = (node: JSONNode, type: string) => node.marks?.some(m => m.type === type) ?? false;

/** Inline content as text. `gap` and `aiAdded` spans of a clean block are shown as <gap> and <ai> tags. */
function inline(nodes: JSONNode[] | undefined): string {
	let out = '';
	for (const node of nodes ?? []) {
		if (node.type === 'hardBreak') out += '\n';
		else if (typeof node.text === 'string') {
			let text = node.text;
			if (hasMark(node, 'gap')) text = `<gap>${text}</gap>`;
			if (hasMark(node, 'aiAdded')) text = `<ai>${text}</ai>`;
			out += text;
		} else out += inline(node.content);
	}
	return out;
}

/** A top-level block as text: `#` for headings, `-` / `1.` for list items, `>` for quotes. */
export function blockText(block: JSONNode): string {
	switch (block.type) {
		case 'paragraph':
			return inline(block.content);
		case 'heading':
			return `${'#'.repeat(Number(block.attrs?.level ?? 1))} ${inline(block.content)}`;
		case 'bulletList':
		case 'orderedList':
			return (block.content ?? [])
				.map((item, i) => {
					const marker = block.type === 'bulletList' ? '-' : `${i + 1}.`;
					return `${marker} ${(item.content ?? []).map(blockText).join('\n  ')}`;
				})
				.join('\n');
		case 'blockquote':
			return (block.content ?? []).map(b => `> ${blockText(b)}`).join('\n');
		default:
			return block.content ? block.content.map(c => (c.type === 'text' ? inline([c]) : blockText(c))).join('') : '';
	}
}
