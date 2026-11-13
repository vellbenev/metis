// Incremental clean of one note (SPEC 6.2). Runs only when the user presses Clean.
// I1: gets a raw-note reader and the derived-data store only; it cannot write raw notes.
// I3: a clean block is regenerated only if at least one of its source raw blocks changed; a raw block
// whose hash is unchanged and that shares no clean block with a changed block causes no model call.

import { nanoid } from 'nanoid';
import type { BlockId, JSONNode } from '../core/blocks';
import { cleanMessages, retryMessages } from '../prompts/clean';
import type { Enrichment, Provider } from '../provider/types';
import type { VaultPath } from '../vault/store';
import type { CleanNote, RewriteLevel, SyncState } from '../vault/types';
import { affectedIds, diffBlocks, isVerbatimBlock, makeBatches, type Batch, type RawBlock } from './diff';
import { parseCleanOutput, specToNode, verbatimNode, type CleanBlockSpec } from './output';
import type { CleanDerivedStore, RawNoteReader } from './ports';
import { blockText, codeSpans } from './text';

export interface CleanDeps {
	notes: RawNoteReader;
	derived: CleanDerivedStore;
	/** The `clean` provider profile. */
	provider: Provider;
}

export interface CleanOptions {
	rewriteLevel: RewriteLevel;
	enrichment: Enrichment;
	/** Neighbouring clean blocks sent as read-only context, on each side of a batch. */
	contextBlocks?: number;
	/** Most raw blocks in one model request. */
	maxBatchBlocks?: number;
	signal?: AbortSignal;
}

export interface FailedBatch {
	blockIds: BlockId[];
	error: string;
}

export interface CleanReport {
	/** False when there was nothing to change (nothing written, no new revision). */
	changed: boolean;
	revision: number;
	/** Model requests made, retries included. */
	modelCalls: number;
	/** Batches whose output was invalid twice; left untouched. */
	failed: FailedBatch[];
}

const DEFAULT_CONTEXT = 2;
const DEFAULT_MAX_BATCH = 8;

const newId = () => nanoid(12);

/** Clean blocks of up to `n` unaffected raw blocks next to a batch, nearest last (before) or first (after). */
function context(
	blocks: RawBlock[],
	from: number,
	step: 1 | -1,
	n: number,
	affected: Set<BlockId>,
	sync: SyncState | undefined,
	cleanById: Map<BlockId, JSONNode>,
): string[] {
	const out: string[] = [];
	for (let i = from; i >= 0 && i < blocks.length && out.length < n; i += step) {
		if (affected.has(blocks[i].id)) continue;
		for (const cleanId of sync?.blocks[blocks[i].id]?.cleanIds ?? []) {
			const node = cleanById.get(cleanId);
			if (node && out.length < n && !out.includes(blockText(node))) out.push(blockText(node));
		}
	}
	return step === -1 ? out.reverse() : out;
}

export async function runClean(deps: CleanDeps, path: VaultPath, options: CleanOptions): Promise<CleanReport> {
	const { notes, derived, provider } = deps;
	const note = await notes.loadNote(path);
	const fileId = note.fileId;

	// Sync and clean twin only make sense together; if one is missing, start from scratch.
	const storedSync = await derived.loadSync(fileId);
	const storedClean = await derived.loadClean(fileId);
	const [prevSync, prevClean] = storedSync && storedClean ? [storedSync, storedClean] : [undefined, undefined];

	const revision = await nextRevision(derived, fileId, prevSync?.revision, prevClean?.revision);
	const cleanById = new Map((prevClean?.doc.content ?? []).map(n => [n.attrs?.id as BlockId, n]));

	const diff = await diffBlocks(note.doc, prevSync);
	const affected = affectedIds(diff, prevSync);
	const batches = makeBatches(diff.blocks, affected, options.maxBatchBlocks ?? DEFAULT_MAX_BATCH, prevSync);

	const entries: SyncState['blocks'] = {};
	for (const b of diff.blocks) if (prevSync?.blocks[b.id]) entries[b.id] = prevSync.blocks[b.id];
	const fresh = new Map<BlockId, JSONNode>();
	const accept = (b: RawBlock, nodes: JSONNode[]) => {
		for (const node of nodes) fresh.set(node.attrs!.id as BlockId, node);
		entries[b.id] = {
			rawHash: b.rawHash,
			rawText: blockText(b.block),
			cleanIds: nodes.map(n => n.attrs!.id as BlockId),
			lastRevision: revision,
		};
	};

	for (const b of diff.blocks) {
		if (affected.has(b.id) && isVerbatimBlock(b.block)) accept(b, [verbatimNode(b.block, newId(), b.id, revision)]);
	}

	let modelCalls = 0;
	const failed: FailedBatch[] = [];
	const callModel = async (batch: Batch): Promise<CleanBlockSpec[] | string> => {
		const ids = batch.blocks.map(b => b.id);
		const inputCode = batch.blocks.flatMap(b => codeSpans(b.block));
		const messages = cleanMessages({
			blocks: batch.blocks.map(b => {
				const previous = b.kind === 'changed' ? prevSync?.blocks[b.id] : undefined;
				const previousClean = previous?.cleanIds
					.map(id => cleanById.get(id))
					.filter((n): n is JSONNode => n !== undefined)
					.map(blockText)
					.join('\n');
				// States written before rawText existed have no previous raw text; send the clean text alone.
				const previousRaw = previousClean ? previous?.rawText : undefined;
				return {
					id: b.id,
					text: blockText(b.block),
					...(previousRaw ? { previousRaw } : {}),
					...(previousClean ? { previousClean } : {}),
				};
			}),
			contextBefore: context(diff.blocks, batch.start - 1, -1, options.contextBlocks ?? DEFAULT_CONTEXT, affected, prevSync, cleanById),
			contextAfter: context(diff.blocks, batch.end + 1, 1, options.contextBlocks ?? DEFAULT_CONTEXT, affected, prevSync, cleanById),
			rewriteLevel: options.rewriteLevel,
			enrichment: options.enrichment,
		});
		let request = messages;
		let error = '';
		for (let attempt = 0; attempt < 2; attempt++) {
			modelCalls++;
			// A provider error (network, auth, ...) aborts the whole run; nothing is written.
			const reply = (await provider.complete({ messages: request, json: true, signal: options.signal })).content;
			const parsed = parseCleanOutput(reply, ids, options.enrichment, inputCode);
			if (parsed.ok) return parsed.blocks;
			error = parsed.error;
			request = retryMessages(messages, reply, error);
		}
		return error;
	};

	for (const batch of batches) {
		const result = await callModel(batch);
		if (typeof result === 'string') {
			failed.push({ blockIds: batch.blocks.map(b => b.id), error: result });
			continue;
		}
		const nodes = result.map(spec => specToNode(spec, newId(), revision));
		for (const b of batch.blocks) {
			accept(b, nodes.filter(n => (n.attrs!.sources as BlockId[]).includes(b.id)));
		}
	}

	// A raw block whose clean blocks are gone (replaced through a shared clean block) is cleaned again next time.
	const exists = (id: BlockId) => fresh.has(id) || cleanById.has(id);
	for (const [rawId, entry] of Object.entries(entries)) {
		if (!entry.cleanIds.every(exists)) delete entries[rawId];
	}

	// Splice: final order follows raw order; each clean block appears once, at its first source.
	const content: JSONNode[] = [];
	const placed = new Set<BlockId>();
	for (const b of diff.blocks) {
		for (const id of entries[b.id]?.cleanIds ?? []) {
			if (placed.has(id)) continue;
			placed.add(id);
			content.push(fresh.get(id) ?? cleanById.get(id)!);
		}
	}

	const blocks: SyncState['blocks'] = {};
	for (const b of diff.blocks) if (entries[b.id]) blocks[b.id] = entries[b.id];

	// Nothing to write if the clean twin and the sync entries came out exactly as they were.
	const sortedEntries = (b: SyncState['blocks']) => JSON.stringify(Object.keys(b).sort().map(k => [k, b[k]]));
	const unchanged =
		JSON.stringify(content) === JSON.stringify(prevClean?.doc.content ?? []) &&
		sortedEntries(blocks) === sortedEntries(prevSync?.blocks ?? {});
	if (unchanged) {
		return { changed: false, revision: prevSync?.revision ?? 0, modelCalls, failed };
	}

	const clean: CleanNote = { version: 1, fileId, revision, doc: { type: 'doc', content } };
	const sync: SyncState = { version: 1, revision, blocks };
	await derived.saveLastRevision(fileId, revision);
	await derived.saveSnapshot(fileId, revision, { version: 1, clean: storedClean ?? null, sync: storedSync ?? null });
	await derived.saveClean(clean);
	await derived.saveSync(fileId, sync);
	return { changed: true, revision, modelCalls, failed };
}

/**
 * The next revision for a file. Revisions only move forward: the result is above every revision
 * ever issued (the stored high-water mark, which undo leaves alone), every snapshot and `seen`.
 * The caller stores it with `saveLastRevision` when it writes.
 */
export async function nextRevision(
	derived: CleanDerivedStore,
	fileId: string,
	...seen: (number | undefined)[]
): Promise<number> {
	const last = Math.max(
		await derived.loadLastRevision(fileId),
		...(await derived.listSnapshots(fileId)),
		...seen.map(n => n ?? 0),
	);
	return last + 1;
}

/**
 * Restores the latest snapshot (clean twin and sync state) exactly, revision number included.
 * Revision numbers are never reused, so the restored number still names exactly this content: the
 * textbook sees the file as stale unless it was built from this very revision. Drops the snapshot;
 * false if there is none.
 */
export async function undoClean(derived: CleanDerivedStore, fileId: string): Promise<boolean> {
	const revisions = await derived.listSnapshots(fileId);
	if (revisions.length === 0) return false;
	const latest = revisions[revisions.length - 1];
	const snapshot = await derived.loadSnapshot(fileId, latest);
	if (!snapshot) return false;
	const undone = (await derived.loadClean(fileId))?.revision ?? 0;
	if (snapshot.clean) await derived.saveClean(snapshot.clean);
	else await derived.deleteClean(fileId);
	if (snapshot.sync) await derived.saveSync(fileId, snapshot.sync);
	else await derived.deleteSync(fileId);
	// Keep the high-water mark above the undone revision, even in vaults written before it existed.
	const current = Math.max(latest, undone);
	if ((await derived.loadLastRevision(fileId)) < current) await derived.saveLastRevision(fileId, current);
	await derived.deleteSnapshot(fileId, latest);
	return true;
}
