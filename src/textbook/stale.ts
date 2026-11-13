// Which parts of the textbook are behind the clean twins (SPEC section 7, I7). Pure functions.

import type { Textbook, TextbookOutline } from '../vault/types';

type Section = TextbookOutline['sections'][number];

/** fileId -> current clean revision. */
export type CleanRevisions = Record<string, number>;

/**
 * True if the section must be regenerated: it was never built, it lists a file it was not built from
 * (or no longer lists one it was), or one of its files has a clean revision other than the one it was
 * built from. Revisions are never reused (undo restores an older number), so any difference is a change.
 */
export function isSectionStale(section: Section, textbook: Textbook | undefined, revisions: CleanRevisions): boolean {
	const built = textbook?.sections[section.id];
	if (!built) return true;
	const keys = Object.keys(built.sourceRevisions);
	if (keys.length !== section.sourceFileIds.length || keys.some(k => !section.sourceFileIds.includes(k))) return true;
	return section.sourceFileIds.some(f => (revisions[f] ?? 0) !== (built.sourceRevisions[f] ?? 0));
}

/**
 * Files whose clean revision differs from what the textbook was built from: a file is stale if no
 * section lists it yet, or a section that lists it was not built from its current clean revision.
 */
export function staleFileIds(
	revisions: CleanRevisions,
	outline: TextbookOutline | undefined,
	textbook: Textbook | undefined,
): string[] {
	return Object.keys(revisions)
		.filter(fileId => {
			const sections = outline?.sections.filter(s => s.sourceFileIds.includes(fileId)) ?? [];
			if (sections.length === 0) return true;
			return sections.some(s => (textbook?.sections[s.id]?.sourceRevisions[fileId] ?? 0) !== revisions[fileId]);
		})
		.sort();
}

/** The quiet count shown beside the vault. No threshold: the user decides when to build. */
export function countStaleFiles(
	revisions: CleanRevisions,
	outline: TextbookOutline | undefined,
	textbook: Textbook | undefined,
): number {
	return staleFileIds(revisions, outline, textbook).length;
}
