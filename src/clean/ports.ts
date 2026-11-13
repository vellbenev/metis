// The only vault access the clean pipeline gets (I1 by construction). Clean code never sees a
// full vault store: it can read raw notes, and read and write derived data under `.metis/`, nothing else.

import type { DerivedStore, VaultPath } from '../vault/store';
import type { RawNote } from '../vault/types';

/** Read-only access to one raw note at a time. */
export interface RawNoteReader {
	loadNote(path: VaultPath): Promise<RawNote>;
}

/** The part of the derived-data store the clean pipeline uses (sync, clean twin, history). */
export type CleanDerivedStore = Pick<
	DerivedStore,
	| 'loadSync'
	| 'saveSync'
	| 'deleteSync'
	| 'loadClean'
	| 'saveClean'
	| 'deleteClean'
	| 'listSnapshots'
	| 'loadSnapshot'
	| 'saveSnapshot'
	| 'deleteSnapshot'
>;
