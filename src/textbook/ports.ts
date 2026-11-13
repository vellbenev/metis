// The only vault access the textbook pipeline gets (I1 by construction). Textbook code never sees a
// full vault store or a raw note: it reads clean twins, and reads and writes the textbook files under `.metis/`.

import type { DerivedStore } from '../vault/store';

/** Read-only access to the clean twins of a vault (never raw notes). */
export type CleanTwinReader = Pick<DerivedStore, 'listCleanIds' | 'loadClean'>;

/** The part of the derived-data store that holds the outline, the textbook and their undo snapshots. */
export type TextbookStore = Pick<
	DerivedStore,
	| 'loadOutline'
	| 'saveOutline'
	| 'deleteOutline'
	| 'loadTextbook'
	| 'saveTextbook'
	| 'deleteTextbook'
	| 'listTextbookSnapshots'
	| 'loadTextbookSnapshot'
	| 'saveTextbookSnapshot'
	| 'deleteTextbookSnapshot'
>;

export const CLEAN_TWIN_READER_KEYS: (keyof CleanTwinReader)[] = ['listCleanIds', 'loadClean'];
export const TEXTBOOK_STORE_KEYS: (keyof TextbookStore)[] = [
	'loadOutline',
	'saveOutline',
	'deleteOutline',
	'loadTextbook',
	'saveTextbook',
	'deleteTextbook',
	'listTextbookSnapshots',
	'loadTextbookSnapshot',
	'saveTextbookSnapshot',
	'deleteTextbookSnapshot',
];

/** Narrows a derived store to the two textbook ports, so the pipeline cannot reach anything else. */
export function textbookPorts(derived: DerivedStore): { clean: CleanTwinReader; store: TextbookStore } {
	const pick = <K extends keyof DerivedStore>(keys: K[]) =>
		Object.fromEntries(keys.map(k => [k, (derived[k] as (...a: unknown[]) => unknown).bind(derived)])) as Pick<DerivedStore, K>;
	return { clean: pick(CLEAN_TWIN_READER_KEYS), store: pick(TEXTBOOK_STORE_KEYS) };
}
