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
	/** Raw blocks, in raw order, sent to the model together (adjacent, unless they share a clean block). */
	blocks: RawBlock[];
	/** Index in `diff.blocks` of the first and last block of the batch. */
	start: number;
	end: number;
}

/** Union-find over string keys; `find` returns a group's representative. */
function unionFind() {
	const parent = new Map<string, string>();
	const find = (x: string): string => {
		while (parent.has(x)) x = parent.get(x)!;
		return x;
	};
	const union = (a: string, b: string) => {
		const [ra, rb] = [find(a), find(b)];
		if (ra !== rb) parent.set(ra, rb);
	};
	return { find, union };
}

/**
 * Groups affected blocks into batches. Adjacent affected blocks form a run; verbatim and unaffected
 * blocks end a run. Raw blocks that share a clean block (in the last SyncState) always land in the
 * same batch, even when they are not adjacent, so a shared clean block is replaced all at once or
 * not at all. A batch is split after `maxBlocks` blocks, but never between blocks that share a clean
 * block, so such a batch may be longer than `maxBlocks`.
 */
export function makeBatches(blocks: RawBlock[], affected: Set<BlockId>, maxBlocks: number, sync?: SyncState): Batch[] {
	// Raw blocks sharing a clean block, transitively.
	const shared = unionFind();
	const ownerOf = new Map<BlockId, BlockId>();
	for (const [rawId, entry] of Object.entries(sync?.blocks ?? {})) {
		for (const cleanId of entry.cleanIds) {
			const owner = ownerOf.get(cleanId);
			if (owner === undefined) ownerOf.set(cleanId, rawId);
			else shared.union(rawId, owner);
		}
	}

	// Runs of adjacent affected blocks (as indices into `blocks`), merged when they share a group.
	const runs: number[][] = [];
	let current: number[] | undefined;
	blocks.forEach((b, i) => {
		if (!affected.has(b.id) || isVerbatimBlock(b.block)) {
			current = undefined;
			return;
		}
		if (!current) runs.push((current = []));
		current.push(i);
	});
	const merged = unionFind();
	const runOfGroup = new Map<string, number>();
	runs.forEach((run, r) => {
		for (const i of run) {
			const group = shared.find(blocks[i].id);
			const other = runOfGroup.get(group);
			if (other === undefined) runOfGroup.set(group, r);
			else merged.union(String(r), String(other));
		}
	});
	const byRoot = new Map<string, number[]>();
	runs.forEach((run, r) => {
		const root = merged.find(String(r));
		byRoot.set(root, [...(byRoot.get(root) ?? []), ...run]);
	});

	const batches: Batch[] = [];
	for (const indices of [...byRoot.values()].map(ix => ix.sort((a, b) => a - b)).sort((a, b) => a[0] - b[0])) {
		// The last position of each group, to know where a cut would separate a group.
		const last = new Map<string, number>();
		indices.forEach((i, p) => last.set(shared.find(blocks[i].id), p));
		let chunk: number[] = [];
		let openUntil = -1;
		const close = () => {
			if (chunk.length > 0) batches.push({ blocks: chunk.map(i => blocks[i]), start: chunk[0], end: chunk[chunk.length - 1] });
			chunk = [];
		};
		indices.forEach((i, p) => {
			if (chunk.length >= maxBlocks && openUntil < p) close();
			chunk.push(i);
			openUntil = Math.max(openUntil, last.get(shared.find(blocks[i].id))!);
		});
		close();
	}
	return batches.sort((a, b) => a.start - b.start);
}
