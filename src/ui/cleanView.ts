// Data actions of the parallel clean pane. They get the narrow derived-data port only (I1):
// they can read and write the clean twin and history under `.metis/`, never a raw note.
//
// Accept/remove of an `aiAdded` span is a new revision of the clean twin, like a clean: it takes
// the next forward-only revision number, snapshots the previous twin and sync state into history
// (so Undo restores them exactly), and sets the new revision on the twin and the sync state. Block
// ids, sources, `changedIn` and the sync block entries stay as they are; the textbook then sees the
// file as stale.
//
// Every write runs under the per-file lock shared with the Clean button, and only applies to the
// revision the pane showed: if the twin changed meanwhile, the action does nothing.

import { nextRevision, undoClean } from '../clean/clean';
import type { CleanDerivedStore } from '../clean/ports';
import { acceptAiAdded, removeAiAdded } from '../cleanView/model';
import type { BlockId } from '../core/blocks';
import type { CleanNote } from '../vault/types';
import { withFileLock } from './fileLock';

export interface CleanViewState {
	clean?: CleanNote;
	/** True when the last change of the clean twin can be undone (a history snapshot exists). */
	canUndo: boolean;
}

export async function loadCleanView(derived: CleanDerivedStore, fileId: string): Promise<CleanViewState> {
	const [clean, snapshots] = await Promise.all([derived.loadClean(fileId), derived.listSnapshots(fileId)]);
	return { clean, canUndo: snapshots.length > 0 };
}

async function editClean(
	derived: CleanDerivedStore,
	fileId: string,
	expected: number,
	edit: (clean: CleanNote) => CleanNote | undefined,
): Promise<boolean> {
	return withFileLock(derived, fileId, async () => {
		const clean = await derived.loadClean(fileId);
		const sync = await derived.loadSync(fileId);
		if (!clean || !sync || clean.revision !== expected) return false;
		const edited = edit(clean);
		if (!edited) return false;
		const revision = await nextRevision(derived, fileId, clean.revision, sync.revision);
		await derived.saveLastRevision(fileId, revision);
		await derived.saveSnapshot(fileId, revision, { version: 1, clean, sync });
		await derived.saveClean({ ...edited, revision });
		await derived.saveSync(fileId, { ...sync, revision });
		return true;
	});
}

/** Accepts one `aiAdded` span of the clean twin at revision `expected`. False if nothing changed. */
export const acceptAi = (
	derived: CleanDerivedStore,
	fileId: string,
	expected: number,
	blockId: BlockId,
	index: number,
) => editClean(derived, fileId, expected, c => acceptAiAdded(c, blockId, index));

/** Removes one `aiAdded` span of the clean twin at revision `expected`. False if nothing changed. */
export const removeAi = (
	derived: CleanDerivedStore,
	fileId: string,
	expected: number,
	blockId: BlockId,
	index: number,
) => editClean(derived, fileId, expected, c => removeAiAdded(c, blockId, index));

/**
 * Restores the clean twin and sync state from before the last change (a clean, accept or remove)
 * exactly (SPEC 6.2 step 8), if the twin is still at revision `expected` (undefined: no twin).
 */
export function undoLastClean(
	derived: CleanDerivedStore,
	fileId: string,
	expected: number | undefined,
): Promise<boolean> {
	return withFileLock(derived, fileId, async () => {
		if ((await derived.loadClean(fileId))?.revision !== expected) return false;
		return undoClean(derived, fileId);
	});
}
