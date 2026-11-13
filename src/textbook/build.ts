// Textbook build (SPEC section 7). Runs only when the user presses the Textbook control.
// I1: gets a clean-twin reader and the textbook part of the derived store only; never raw notes.
// I7: section ids and order are stable; a section is regenerated only if its source files changed.

import { nanoid } from 'nanoid';
import { outlineMessages, retryMessages, sectionMessages } from '../prompts/textbook';
import type { ChatMessage, Enrichment, Provider } from '../provider/types';
import type { CleanNote, Textbook, TextbookOutline } from '../vault/types';
import { applyDelta, noChanges, pruneOutline, type OutlineChanges } from './delta';
import type { CleanTwinReader, TextbookStore } from './ports';
import { parseSectionOutput, sectionDoc, sectionGaps } from './section';
import { countStaleFiles, isSectionStale, staleFileIds, type CleanRevisions } from './stale';
import { cleanHeadings, cleanText } from './text';

export interface TextbookDeps {
	clean: CleanTwinReader;
	store: TextbookStore;
	/** The `textbook` provider profile. */
	provider: Provider;
}

export interface TextbookOptions {
	enrichment: Enrichment;
	signal?: AbortSignal;
	now?: () => number;
}

export interface TextbookReport {
	/** False when there was nothing to change (nothing written, no snapshot). */
	changed: boolean;
	/** Model requests made, retries included. */
	modelCalls: number;
	/** What the outline delta changed, for highlighting. */
	outline: OutlineChanges;
	/** Set when the delta was invalid twice; the outline was left untouched. */
	outlineError?: string;
	regenerated: string[];
	/** Sections whose output was invalid twice; left untouched. */
	failed: { sectionId: string; error: string }[];
}

const newId = () => nanoid(12);

export async function loadCleanTwins(clean: CleanTwinReader): Promise<Map<string, CleanNote>> {
	const twins = new Map<string, CleanNote>();
	for (const id of (await clean.listCleanIds()).sort()) {
		const note = await clean.loadClean(id);
		if (note) twins.set(id, note);
	}
	return twins;
}

export const revisionsOf = (twins: Map<string, CleanNote>): CleanRevisions =>
	Object.fromEntries([...twins].map(([id, note]) => [id, note.revision]));

/** Calls the model, validates, retries once with the error. Returns the parsed value or the last error. */
async function ask<T>(
	provider: Provider,
	messages: ChatMessage[],
	parse: (reply: string) => { ok: true; value: T } | { ok: false; error: string },
	shape: string,
	count: () => void,
	signal?: AbortSignal,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
	let request = messages;
	let error = '';
	for (let attempt = 0; attempt < 2; attempt++) {
		count();
		// A provider error (network, auth, ...) aborts the whole build; nothing is written.
		const reply = (await provider.complete({ messages: request, json: true, signal })).content;
		const parsed = parse(reply);
		if (parsed.ok) return parsed;
		error = parsed.error;
		request = retryMessages(messages, reply, error, shape);
	}
	return { ok: false, error };
}

export async function buildTextbook(deps: TextbookDeps, options: TextbookOptions): Promise<TextbookReport> {
	const { clean, store, provider } = deps;
	const twins = await loadCleanTwins(clean);
	const revisions = revisionsOf(twins);
	const fileIds = [...twins.keys()];
	const storedOutline = await store.loadOutline();
	const storedTextbook = await store.loadTextbook();

	let modelCalls = 0;
	const count = () => void modelCalls++;
	const report: TextbookReport = { changed: false, modelCalls: 0, outline: noChanges(), regenerated: [], failed: [] };

	// 1. Outline: drop files that are gone, then ask for a delta if any file is new or changed.
	const pruned = pruneOutline(storedOutline ?? { version: 1, sections: [] }, fileIds);
	let outline = pruned.outline;
	const stale = staleFileIds(revisions, outline, storedTextbook);
	if (stale.length > 0) {
		const messages = outlineMessages({
			outline: outline.sections.map(s => ({ id: s.id, title: s.title, files: s.sourceFileIds })),
			files: fileIds.map(id => {
				const note = twins.get(id)!;
				const changed = stale.includes(id);
				return { fileId: id, changed, headings: cleanHeadings(note), ...(changed ? { text: cleanText(note) } : {}) };
			}),
		});
		const result = await ask(
			provider,
			messages,
			reply => {
				const r = applyDelta(reply, outline, fileIds, newId);
				return r.ok ? { ok: true, value: r } : r;
			},
			'{"ops": [...]}',
			count,
			options.signal,
		);
		if (result.ok) {
			outline = result.value.outline;
			report.outline = result.value.changes;
		} else report.outlineError = result.error;
	}
	report.outline.dropped = pruned.dropped;

	// 2. Sections: regenerate only the stale ones; every other section is kept as it is (I7).
	const sections: Textbook['sections'] = {};
	const gaps: Textbook['gaps'] = [];
	const titles = outline.sections.map(s => s.title);
	for (const section of outline.sections) {
		const previous = storedTextbook?.sections[section.id];
		const previousGaps = storedTextbook?.gaps.filter(g => g.sectionId === section.id) ?? [];
		if (!isSectionStale(section, storedTextbook, revisions)) {
			sections[section.id] = previous!;
			gaps.push(...previousGaps);
			continue;
		}
		const messages = sectionMessages({
			title: section.title,
			outline: titles,
			files: section.sourceFileIds.map(id => ({ fileId: id, text: cleanText(twins.get(id)!) })),
			enrichment: options.enrichment,
		});
		const result = await ask(
			provider,
			messages,
			reply => {
				const r = parseSectionOutput(reply, options.enrichment);
				return r.ok ? { ok: true, value: r } : r;
			},
			'{"blocks": [...], "gaps": [...]}',
			count,
			options.signal,
		);
		if (!result.ok) {
			report.failed.push({ sectionId: section.id, error: result.error });
			if (previous) {
				sections[section.id] = previous;
				gaps.push(...previousGaps);
			}
			continue;
		}
		sections[section.id] = {
			doc: sectionDoc(result.value.blocks, newId),
			sourceRevisions: Object.fromEntries(section.sourceFileIds.map(id => [id, revisions[id]])),
		};
		for (const note of sectionGaps(result.value.blocks, result.value.gaps)) gaps.push({ sectionId: section.id, note });
		report.regenerated.push(section.id);
	}
	report.modelCalls = modelCalls;

	const outlineChanged = JSON.stringify(outline) !== JSON.stringify(storedOutline ?? { version: 1, sections: [] });
	const sectionsChanged =
		report.regenerated.length > 0 ||
		JSON.stringify(Object.keys(sections).sort()) !== JSON.stringify(Object.keys(storedTextbook?.sections ?? {}).sort());
	if (!outlineChanged && !sectionsChanged) return report;

	const textbook: Textbook = {
		version: 1,
		builtAt: report.regenerated.length > 0 || !storedTextbook ? (options.now ?? Date.now)() : storedTextbook.builtAt,
		sections,
		gaps,
	};
	const snapshots = await store.listTextbookSnapshots();
	const next = (snapshots[snapshots.length - 1] ?? 0) + 1;
	await store.saveTextbookSnapshot(next, { version: 1, outline: storedOutline ?? null, textbook: storedTextbook ?? null });
	await store.saveOutline(outline);
	await store.saveTextbook(textbook);
	report.changed = true;
	return report;
}

/** Restores the outline and textbook from before the latest build and drops that snapshot. False if there is none. */
export async function undoTextbook(store: TextbookStore): Promise<boolean> {
	const snapshots = await store.listTextbookSnapshots();
	if (snapshots.length === 0) return false;
	const latest = snapshots[snapshots.length - 1];
	const snapshot = await store.loadTextbookSnapshot(latest);
	if (!snapshot) return false;
	if (snapshot.outline) await store.saveOutline(snapshot.outline);
	else await store.deleteOutline();
	if (snapshot.textbook) await store.saveTextbook(snapshot.textbook);
	else await store.deleteTextbook();
	await store.deleteTextbookSnapshot(latest);
	return true;
}

/** The current stale-file count of a vault, for the quiet indicator. */
export async function staleCount(clean: CleanTwinReader, store: TextbookStore): Promise<number> {
	const revisions = revisionsOf(await loadCleanTwins(clean));
	return countStaleFiles(revisions, await store.loadOutline(), await store.loadTextbook());
}
