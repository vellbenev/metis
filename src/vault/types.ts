// On-disk types of a vault (SPEC section 5).

import type { BlockId, JSONNode } from '../core/blocks';

export type TipTapJSON = JSONNode;

export type RewriteLevel = 'light' | 'structure' | 'full';

/** metis.vault.json */
export interface VaultMeta {
	version: 1;
	name: string;
	createdAt: number; // ms since epoch
	defaults: { rewriteLevel: RewriteLevel };
}

/** notes/<folder>/<file>.metis.json. Written only by the editor. */
export interface RawNote {
	version: 1;
	fileId: string; // stable uuid
	title: string;
	doc: TipTapJSON; // every top-level node has attrs.id: BlockId
}

/** .metis/sync/<fileId>.json */
export interface SyncState {
	version: 1;
	revision: number; // +1 per successful clean
	blocks: Record<BlockId, SyncBlock>;
}

export interface SyncBlock {
	rawHash: string;
	/** The normalised raw text last sent to (or copied by) the clean; absent in states written before it existed. */
	rawText?: string;
	cleanIds: BlockId[];
	lastRevision: number;
}

/** .metis/clean/<fileId>.json */
export interface CleanNote {
	version: 1;
	fileId: string;
	revision: number;
	doc: TipTapJSON; // top-level nodes: attrs.id, attrs.sources: BlockId[], attrs.changedIn: number
}

/** .metis/history/<fileId>/<revision>.json: the state before a clean, for undo. */
export interface HistorySnapshot {
	version: 1;
	clean: CleanNote | null;
	sync: SyncState | null;
}

/** .metis/textbook/outline.json */
export interface TextbookOutline {
	version: 1;
	sections: { id: string; title: string; sourceFileIds: string[]; order: number }[];
}

/** .metis/textbook/textbook.json */
export interface Textbook {
	version: 1;
	builtAt: number;
	sections: Record<string, { doc: TipTapJSON; sourceRevisions: Record<string, number> }>;
	gaps: { sectionId: string; note: string }[];
}

/** .metis/textbook/history/<n>.json: the outline and textbook before a build, for undo. */
export interface TextbookSnapshot {
	version: 1;
	outline: TextbookOutline | null;
	textbook: Textbook | null;
}
