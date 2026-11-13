// Plain-text views of clean twins for the textbook prompts.

import type { JSONNode } from '../core/blocks';
import type { CleanNote } from '../vault/types';

const mark = (node: JSONNode, type: string) => node.marks?.find(m => m.type === type);

/**
 * Inline content as text. `gap` spans are shown as <gap> tags. Text the model added to a clean twin
 * that the user has not accepted is left out: the textbook is built from the user's notes only.
 */
function inline(nodes: JSONNode[] | undefined): string {
	let out = '';
	for (const node of nodes ?? []) {
		if (node.type === 'hardBreak') out += '\n';
		else if (typeof node.text === 'string') {
			const ai = mark(node, 'aiAdded');
			if (ai && ai.attrs?.accepted !== true) continue;
			out += mark(node, 'gap') ? `<gap>${node.text}</gap>` : node.text;
		} else out += inline(node.content);
	}
	return out;
}

/** A top-level block as text: `#` for headings, `-` / `1.` for list items, `>` for quotes, fences for code. */
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
		case 'codeBlock':
			return `\`\`\`\n${inline(block.content)}\n\`\`\``;
		default:
			return block.content ? block.content.map(c => (c.type === 'text' ? inline([c]) : blockText(c))).join('') : '';
	}
}

export function cleanText(note: CleanNote): string {
	return (note.doc.content ?? [])
		.map(blockText)
		.filter(t => t.trim())
		.join('\n');
}

export function cleanHeadings(note: CleanNote): string[] {
	return (note.doc.content ?? []).filter(b => b.type === 'heading').map(b => inline(b.content));
}
