// Pure logic of the parallel clean view (SPEC 9, slice S5): block linking, change highlights,
// `gap` collection and the one-click `aiAdded` accept/remove transforms.
// Everything here works on the derived CleanNote only; the raw note is never an input (I1).

import { gapReason, type GapReason } from '../clean/output';
import type { BlockId, JSONNode } from '../core/blocks';
import type { CleanNote } from '../vault/types';

const hasMark = (node: JSONNode, type: string) => node.marks?.some(m => m.type === type) ?? false;
const isText = (node: JSONNode) => typeof node.text === 'string';
const blocksOf = (clean: CleanNote | undefined): JSONNode[] => clean?.doc.content ?? [];
const idOf = (block: JSONNode) => block.attrs?.id as BlockId;
const sourcesOf = (block: JSONNode) => (block.attrs?.sources as BlockId[] | undefined) ?? [];

// ---- block linking -----------------------------------------------------------------------------

export interface LinkMap {
	/** Raw block id -> clean block ids that have it as a source, in clean order. */
	rawToClean: Map<BlockId, BlockId[]>;
	/** Clean block id -> its source raw block ids (`attrs.sources`). */
	cleanToRaw: Map<BlockId, BlockId[]>;
}

export function linkMap(clean: CleanNote | undefined): LinkMap {
	const rawToClean = new Map<BlockId, BlockId[]>();
	const cleanToRaw = new Map<BlockId, BlockId[]>();
	for (const block of blocksOf(clean)) {
		const id = idOf(block);
		cleanToRaw.set(id, [...sourcesOf(block)]);
		for (const raw of sourcesOf(block)) rawToClean.set(raw, [...(rawToClean.get(raw) ?? []), id]);
	}
	return { rawToClean, cleanToRaw };
}

export type Side = 'raw' | 'clean';
export interface BlockRef {
	side: Side;
	id: BlockId;
}

/**
 * The blocks to highlight on both sides when a block is selected: the block itself and its
 * counterparts. Selecting a clean block also lights the other clean blocks of the same sources,
 * so the whole correspondence is visible.
 */
export function linkedBlocks(map: LinkMap, selected: BlockRef | undefined): { raw: BlockId[]; clean: BlockId[] } {
	if (!selected) return { raw: [], clean: [] };
	const raw = selected.side === 'raw' ? [selected.id] : (map.cleanToRaw.get(selected.id) ?? []);
	const clean = [...new Set(raw.flatMap(r => map.rawToClean.get(r) ?? []))];
	if (selected.side === 'clean' && !clean.includes(selected.id)) clean.unshift(selected.id);
	return { raw, clean };
}

// ---- change highlights -------------------------------------------------------------------------

/**
 * The revision of the last clean. Accept/remove of an `aiAdded` span takes a new revision but is not
 * a clean, so it leaves this alone. Twins written before `lastClean` existed use their revision.
 */
export const lastCleanOf = (clean: CleanNote) => clean.lastClean ?? clean.revision;

/** Clean blocks new or changed in the last clean: `changedIn` is that clean's revision (SPEC 9). */
export function changedBlocks(clean: CleanNote | undefined): BlockId[] {
	if (!clean) return [];
	const last = lastCleanOf(clean);
	return blocksOf(clean)
		.filter(b => b.attrs?.changedIn === last)
		.map(idOf);
}

/**
 * Highlights are dismissed per clean, as UI state only: the key names the clean they belong to, so
 * a new clean or another note shows its own highlights again, and accept/remove keeps them dismissed.
 */
export const highlightKey = (clean: CleanNote) => `${clean.fileId}:${lastCleanOf(clean)}`;

export function visibleHighlights(clean: CleanNote | undefined, dismissed: ReadonlySet<string>): BlockId[] {
	if (!clean || dismissed.has(highlightKey(clean))) return [];
	return changedBlocks(clean);
}

// ---- inline runs -------------------------------------------------------------------------------

export type Segment = { run: JSONNode[] } | { node: JSONNode };

/**
 * Splits a node list into maximal runs of adjacent text nodes carrying `mark`, and other nodes.
 * A run is what the user sees as one span (e.g. an `aiAdded` phrase partly in bold).
 */
export function segments(content: JSONNode[] | undefined, mark: string): Segment[] {
	const out: Segment[] = [];
	for (const node of content ?? []) {
		const last = out[out.length - 1];
		if (isText(node) && hasMark(node, mark)) {
			if (last && 'run' in last) last.run.push(node);
			else out.push({ run: [node] });
		} else out.push({ node });
	}
	return out;
}

/** Runs of `mark` in a block, in document order (depth first). Run indices count from 0 per block. */
export function runsIn(block: JSONNode, mark: string): JSONNode[][] {
	const out: JSONNode[][] = [];
	const visit = (node: JSONNode) => {
		for (const s of segments(node.content, mark)) {
			if ('run' in s) out.push(s.run);
			else if (s.node.content) visit(s.node);
		}
	};
	visit(block);
	return out;
}

const runText = (run: JSONNode[]) => run.map(n => n.text).join('');

// ---- gaps --------------------------------------------------------------------------------------

export interface GapItem {
	blockId: BlockId;
	/** Index of the span among the block's `gap` spans. */
	index: number;
	text: string;
	/** `unclear` in the notes, or `term-missing` (a Latin term the clean lost). */
	reason: GapReason;
}

const reasonOf = (node: JSONNode) => gapReason(node.marks!.find(m => m.type === 'gap')!);

/**
 * Every `gap` span of the clean twin, in document order, with the clean block it sits in and its
 * reason. A run of adjacent gap text is one span per reason.
 */
export function collectGaps(clean: CleanNote | undefined): GapItem[] {
	return blocksOf(clean).flatMap(block => {
		const spans: JSONNode[][] = [];
		for (const run of runsIn(block, 'gap')) {
			let span: JSONNode[] | undefined;
			for (const node of run) {
				if (span && reasonOf(span[0]) === reasonOf(node)) span.push(node);
				else spans.push((span = [node]));
			}
		}
		return spans.map((span, index) => ({ blockId: idOf(block), index, text: runText(span), reason: reasonOf(span[0]) }));
	});
}

// ---- aiAdded accept / remove -------------------------------------------------------------------

export interface AiSpan {
	blockId: BlockId;
	index: number;
	text: string;
	accepted: boolean;
}

const isAccepted = (node: JSONNode) => node.marks?.find(m => m.type === 'aiAdded')?.attrs?.accepted === true;

export function aiSpans(clean: CleanNote | undefined): AiSpan[] {
	return blocksOf(clean).flatMap(block =>
		runsIn(block, 'aiAdded').map((run, index) => ({
			blockId: idOf(block),
			index,
			text: runText(run),
			accepted: run.every(isAccepted),
		})),
	);
}

const withText = (node: JSONNode, text: string): JSONNode[] => (text ? [{ ...node, text }] : []);

/**
 * After a run was removed, the text before it (`content[at - 1]`) and after it (`content[at]`) meet.
 * Drops the space left behind: removing ` <ai>x</ai> ` leaves one space, not two, and no space is
 * left before punctuation or at either edge of the paragraph.
 */
function tidyJoint(content: JSONNode[], at: number): void {
	const before = content[at - 1];
	const after = content[at];
	const prev = before && isText(before) ? before.text! : undefined;
	const next = after && isText(after) ? after.text! : undefined;
	if (prev !== undefined && /\s$/.test(prev) && (after === undefined || (next !== undefined && /^[\s.,;:!?،؛؟)»]/.test(next)))) {
		content.splice(at - 1, 1, ...withText(before, prev.replace(/\s+$/, '')));
	} else if (before === undefined && next !== undefined && /^\s/.test(next)) {
		content.splice(at, 1, ...withText(after, next.replace(/^\s+/, '')));
	}
}

/**
 * Rewrites the `index`-th `aiAdded` run of one block. Only that block's inline content changes:
 * the block id, `sources`, `changedIn`, every other block and the revision stay as they are.
 * Returns undefined when the block or run does not exist (e.g. the clean twin changed meanwhile).
 */
function editRun(
	clean: CleanNote,
	blockId: BlockId,
	index: number,
	edit: (run: JSONNode[]) => JSONNode[],
): CleanNote | undefined {
	const at = blocksOf(clean).findIndex(b => idOf(b) === blockId);
	if (at < 0) return undefined;
	let seen = 0;
	let done = false;
	const visit = (node: JSONNode): JSONNode => {
		if (!node.content) return node;
		const content: JSONNode[] = [];
		let joint: number | undefined;
		for (const s of segments(node.content, 'aiAdded')) {
			if ('node' in s) content.push(done ? s.node : visit(s.node));
			else if (!done && seen++ === index) {
				const replaced = edit(s.run);
				content.push(...replaced);
				if (replaced.length === 0) joint = content.length;
				done = true;
			} else content.push(...s.run);
		}
		if (joint !== undefined) tidyJoint(content, joint);
		return { ...node, content };
	};
	const block = visit(blocksOf(clean)[at]);
	if (!done) return undefined;
	const content = [...blocksOf(clean)];
	content[at] = block;
	return { ...clean, doc: { ...clean.doc, content } };
}

/** One-click accept: the run keeps its `aiAdded` provenance with `accepted: true` (I4). */
export function acceptAiAdded(clean: CleanNote, blockId: BlockId, index: number): CleanNote | undefined {
	return editRun(clean, blockId, index, run =>
		run.map(n => ({
			...n,
			marks: n.marks!.map(m => (m.type === 'aiAdded' ? { ...m, attrs: { ...m.attrs, accepted: true } } : m)),
		})),
	);
}

/** One-click remove: deletes the run's text from the clean twin, and the space it leaves behind. */
export function removeAiAdded(clean: CleanNote, blockId: BlockId, index: number): CleanNote | undefined {
	return editRun(clean, blockId, index, () => []);
}
