// Data actions of the parallel clean pane. They get the narrow derived-data port only (I1):
// they can read and write the clean twin and history under `.metis/`, never a raw note.
//
// Accept/remove of an `aiAdded` span rewrite the stored clean twin in place. They write no history
// snapshot and do not bump the revision: history holds one snapshot per clean revision (SPEC 5),
// and the sync state does not change (same blocks, ids, sources and raw hashes). Undo restores the
// snapshot taken before the last clean, so it also drops accepts/removes made since that clean.

import { undoClean } from '../clean/clean';
import type { CleanDerivedStore } from '../clean/ports';
import { acceptAiAdded, removeAiAdded } from '../cleanView/model';
import type { BlockId } from '../core/blocks';
import type { CleanNote } from '../vault/types';

export interface CleanViewState {
	clean?: CleanNote;
	/** True when a clean can be undone (a history snapshot exists). */
	canUndo: boolean;
}

export async function loadCleanView(derived: CleanDerivedStore, fileId: string): Promise<CleanViewState> {
	const [clean, snapshots] = await Promise.all([derived.loadClean(fileId), derived.listSnapshots(fileId)]);
	return { clean, canUndo: snapshots.length > 0 };
}

async function editClean(
	derived: CleanDerivedStore,
	fileId: string,
	edit: (clean: CleanNote) => CleanNote | undefined,
): Promise<boolean> {
	const clean = await derived.loadClean(fileId);
	const next = clean && edit(clean);
	if (!next) return false;
	await derived.saveClean(next);
	return true;
}

export const acceptAi = (derived: CleanDerivedStore, fileId: string, blockId: BlockId, index: number) =>
	editClean(derived, fileId, c => acceptAiAdded(c, blockId, index));

export const removeAi = (derived: CleanDerivedStore, fileId: string, blockId: BlockId, index: number) =>
	editClean(derived, fileId, c => removeAiAdded(c, blockId, index));

/** Restores the clean twin and sync state from before the last clean, exactly (SPEC 6.2 step 8). */
export const undoLastClean = (derived: CleanDerivedStore, fileId: string) => undoClean(derived, fileId);
