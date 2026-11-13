// Block diff and batching for the incremental clean (SPEC 6.2 steps 1-3).

import { canonicalHash, type BlockId, type JSONNode } from '../core/blocks';
import { normalizeNode } from '../core/normalize';
import type { SyncState } from '../vault/types';

export type BlockKind = 'new' | 'changed' | 'unchanged';

export interface RawBlock {
	id: BlockId;
	/** The normalised block (6.1): what is hashed and what the model sees. */
	block: JSONNode;
	rawHash: string;
	kind: BlockKind;
}

export interface BlockDiff {
	/** Non-empty raw blocks in raw order. */
	blocks: RawBlock[];
	/** Ids in the SyncState that are no longer in the raw doc. */
	deleted: BlockId[];
}

/** A paragraph with no content at all. Horizontal rules, images and code blocks are never empty. */
export function isEmptyBlock(block: JSONNode): boolean {
	return block.type === 'paragraph' && (block.content === undefined || block.content.length === 0);
}

function hasText(node: JSONNode): boolean {
	return (typeof node.text === 'string' && node.text.length > 0) || (node.content ?? []).some(hasText);
}

/**
 * Blocks the clean copies as they are, without a model call: code blocks (code is never rewritten)
 * and blocks with no text at all (horizontal rule, image, ...).
 */
export function isVerbatimBlock(block: JSONNode): boolean {
	return block.type === 'codeBlock' || !hasText(block);
}

/** Normalises, hashes and classifies every non-empty top-level block against the last SyncState. */
export async function diffBlocks(doc: JSONNode, sync: SyncState | undefined): Promise<BlockDiff> {
	const known = sync?.blocks ?? {};
	const seen = new Set<BlockId>();
	const blocks: RawBlock[] = [];
	for (const raw of doc.content ?? []) {
		if (isEmptyBlock(raw)) continue;
		const id = raw.attrs?.id;
		if (typeof id !== 'string' || id === '') throw new Error(`raw block without id: ${raw.type}`);
		if (seen.has(id)) throw new Error(`duplicate block id in raw note: ${id}`);
		seen.add(id);
		const block = normalizeNode(raw);
		const rawHash = await canonicalHash(block);
		const prev = Object.hasOwn(known, id) ? known[id] : undefined;
		const kind: BlockKind = !prev ? 'new' : prev.rawHash === rawHash ? 'unchanged' : 'changed';
		blocks.push({ id, block, rawHash, kind });
	}
	const deleted = Object.keys(known).filter(id => !seen.has(id));
	return { blocks, deleted };
}

/**
 * Raw blocks that must be (re)cleaned: new and changed blocks, plus unchanged blocks that share a
 * clean block with a changed or deleted block (that shared clean block cannot survive as it is).
 */
export function affectedIds(diff: BlockDiff, sync: SyncState | undefined): Set<BlockId> {
	const affected = new Set(diff.blocks.filter(b => b.kind !== 'unchanged').map(b => b.id));
	if (!sync) return affected;
	const owners = new Map<BlockId, BlockId[]>();
	for (const [rawId, entry] of Object.entries(sync.blocks)) {
		for (const cleanId of entry.cleanIds) owners.set(cleanId, [...(owners.get(cleanId) ?? []), rawId]);
	}
	const present = new Set(diff.blocks.map(b => b.id));
	const queue = [...affected, ...diff.deleted];
	const visited = new Set(queue);
	while (queue.length > 0) {
		const rawId = queue.pop()!;
		for (const cleanId of sync.blocks[rawId]?.cleanIds ?? []) {
			for (const other of owners.get(cleanId) ?? []) {
				if (visited.has(other)) continue;
				visited.add(other);
				queue.push(other);
				if (present.has(other)) affected.add(other);
			}
		}
	}
	return affected;
}

export interface Batch {
	/** Adjacent raw blocks, in raw order, sent to the model together. */
	blocks: RawBlock[];
	/** Index in `diff.blocks` of the first and last block of the batch. */
	start: number;
	end: number;
}

/** Groups adjacent affected blocks into batches. Verbatim blocks and unaffected blocks split batches. */
export function makeBatches(blocks: RawBlock[], affected: Set<BlockId>, maxBlocks: number): Batch[] {
	const batches: Batch[] = [];
	let current: Batch | undefined;
	blocks.forEach((b, i) => {
		const join = affected.has(b.id) && !isVerbatimBlock(b.block);
		if (!join) {
			current = undefined;
			return;
		}
		if (!current || current.blocks.length >= maxBlocks) {
			current = { blocks: [], start: i, end: i };
			batches.push(current);
		}
		current.blocks.push(b);
		current.end = i;
	});
	return batches;
}
