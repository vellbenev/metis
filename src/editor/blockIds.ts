import { Extension } from '@tiptap/core';
import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { ReplaceStep, type Mapping } from '@tiptap/pm/transform';
import { nanoid } from 'nanoid';

// Node types that can appear at the top level of a document and therefore carry a block id.
// When nested (e.g. a paragraph inside a list item) they must not carry one.
export const BLOCK_TYPES = [
	'paragraph',
	'heading',
	'bulletList',
	'orderedList',
	'blockquote',
	'codeBlock',
	'horizontalRule',
];

export interface BlockIdsOptions {
	generateId: () => string;
}

export const blockIdsKey = new PluginKey('blockIds');

function mint(seen: Set<string>, generate: () => string): string {
	let id = generate();
	while (seen.has(id)) id = generate();
	seen.add(id);
	return id;
}

/**
 * Returns a transaction that makes top-level ids valid, or null if nothing needs to change:
 * every top-level block has a unique id, nested nodes have none.
 * When an id appears twice, the node that existed before (found via `mapping`) keeps it.
 */
export function fixIds(
	state: EditorState,
	seen: Set<string>,
	generate: () => string,
	previous?: { doc: PMNode; mapping: Mapping; wholeReplace: boolean },
): Transaction | null {
	const { doc } = state;
	const tr = state.tr;
	let changed = false;

	const oldPos = new Map<string, number>();
	previous?.doc.forEach((node, offset) => {
		const id = node.attrs.id as string | null;
		if (id && !oldPos.has(id)) oldPos.set(id, offset);
	});

	const byId = new Map<string, number[]>();
	doc.forEach((node, offset) => {
		const id = node.attrs.id as string | null | undefined;
		if (id) {
			seen.add(id);
			byId.set(id, [...(byId.get(id) ?? []), offset]);
		}
	});

	// In-place type changes (paragraph -> list, list -> paragraph) rebuild the top-level node.
	// The id of the block it came from, now gone from the top level, moves to the new node.
	const missing = new Set([...oldPos.keys()].filter(id => !byId.has(id)));
	const adopt = (node: PMNode, offset: number): string | null => {
		let found: string | null = null;
		node.descendants(child => {
			if (!found && child.attrs.id && missing.has(child.attrs.id)) found = child.attrs.id;
			return !found;
		});
		if (!found && previous && !previous.wholeReplace) {
			for (const id of missing) {
				const old = previous.doc.nodeAt(oldPos.get(id)!)!;
				if (previous.mapping.map(oldPos.get(id)!, -1) === offset && old.textContent.includes(node.textContent)) {
					found = id;
					break;
				}
			}
		}
		if (found) missing.delete(found);
		return found;
	};

	doc.forEach((node, offset) => {
		if (!('id' in node.attrs)) return;
		const id = node.attrs.id as string | null;
		let keep = !!id;
		if (!id) {
			const adopted = adopt(node, offset);
			if (adopted) {
				tr.setNodeAttribute(offset, 'id', adopted);
				changed = true;
				return;
			}
		}
		if (id) {
			const positions = byId.get(id)!;
			if (positions.length > 1) {
				const before = oldPos.get(id);
				const mapped = before !== undefined && previous ? previous.mapping.map(before, 1) : undefined;
				const keeper = mapped !== undefined && positions.includes(mapped) ? mapped : positions[0];
				keep = offset === keeper;
			}
		}
		if (!keep) {
			tr.setNodeAttribute(offset, 'id', mint(seen, generate));
			changed = true;
		}
	});

	doc.forEach((top, topOffset) => {
		top.descendants((node, pos) => {
			if (node.attrs.id) {
				tr.setNodeAttribute(topOffset + 1 + pos, 'id', null);
				changed = true;
			}
		});
	});

	if (!changed) return null;
	return tr.setMeta(blockIdsKey, true);
}

/** Drops top-level ids of the slice that already exist in `doc` (copy); others are kept (cut = move). */
function stripExistingIds(slice: Slice, doc: PMNode): Slice {
	const inDoc = new Set<string>();
	doc.forEach(node => node.attrs.id && inDoc.add(node.attrs.id));
	const nodes: PMNode[] = [];
	slice.content.forEach(node => {
		const copy = node.attrs.id && inDoc.has(node.attrs.id);
		nodes.push(copy ? node.type.create({ ...node.attrs, id: null }, node.content, node.marks) : node);
	});
	return new Slice(Fragment.from(nodes), slice.openStart, slice.openEnd);
}

/**
 * Stable block ids (SPEC I2). Ids live in `attrs.id` of top-level nodes only.
 * - edit / merge: ProseMirror keeps the first node's attrs, so the id stays.
 * - split: the second part does not inherit the id (keepOnSplit: false) and gets a new one.
 * - type change (paragraph -> heading/list/quote and back): the new node takes the old id.
 * - paste: a pasted block whose id is already in the document is a copy and gets a new id;
 *   otherwise it keeps its id (cut-paste is a move).
 * - drag-move: the dragged slice keeps its ids; the original is deleted in the same step.
 */
export const BlockIds = Extension.create<BlockIdsOptions>({
	name: 'blockIds',

	addOptions() {
		return { generateId: () => nanoid(12) };
	},

	addGlobalAttributes() {
		return [
			{
				types: BLOCK_TYPES,
				attributes: {
					id: {
						default: null,
						keepOnSplit: false,
						parseHTML: el => el.getAttribute('data-block-id'),
						renderHTML: attrs => (attrs.id ? { 'data-block-id': attrs.id } : {}),
					},
				},
			},
		];
	},

	onBeforeCreate() {
		// 'mount' fires synchronously once the view exists ('create' is deferred), so a loaded
		// document has valid ids before anyone reads it.
		this.editor.on('mount', ({ editor }) => {
			const seen = blockIdsKey.getState(editor.state) as Set<string>;
			const tr = fixIds(editor.state, seen, this.options.generateId);
			if (tr) editor.view.dispatch(tr.setMeta('addToHistory', false));
		});
	},

	addProseMirrorPlugins() {
		const generate = this.options.generateId;
		return [
			new Plugin<Set<string>>({
				key: blockIdsKey,
				// Every id this editor has seen; minting skips them so ids are never reused.
				state: {
					init: (_, state) => {
						const seen = new Set<string>();
						state.doc.forEach(node => node.attrs.id && seen.add(node.attrs.id));
						return seen;
					},
					apply: (_, seen) => seen,
				},
				appendTransaction(transactions, oldState, newState) {
					if (!transactions.some(t => t.docChanged)) return null;
					const seen = blockIdsKey.getState(newState) as Set<string>;
					const mapping = transactions[0].mapping.slice(0);
					for (const t of transactions.slice(1)) mapping.appendMapping(t.mapping);
					// Replacing the whole document (e.g. setContent) is not a type change: no id transfer by position.
					const wholeReplace = transactions.some(t =>
						t.steps.some(
							(step, i) =>
								step instanceof ReplaceStep && step.from === 0 && step.to === t.docs[i].content.size,
						),
					);
					return fixIds(newState, seen, generate, { doc: oldState.doc, mapping, wholeReplace });
				},
				props: {
					transformPasted(slice, view) {
						// A drag inside the editor carries its own slice; keep ids so a move keeps them.
						// If it was a copy-drag, the duplicate is resolved in appendTransaction.
						if (view.dragging && view.dragging.slice === slice) return slice;
						return stripExistingIds(slice, view.state.doc);
					},
				},
			}),
		];
	},
});
