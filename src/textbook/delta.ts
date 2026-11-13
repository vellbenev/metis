// The outline delta (SPEC section 7): the model proposes a small change to the stable outline; this
// code validates it and applies it. Section ids are minted here, never by the model, and an existing
// section keeps its id and its place unless the delta merges or reorders it (I7).

import type { TextbookOutline } from '../vault/types';

type Section = TextbookOutline['sections'][number];

export type DeltaOp =
	| { op: 'add'; title: string; files: string[]; after?: string }
	| { op: 'rename'; id: string; title: string }
	| { op: 'merge'; ids: string[]; title?: string }
	| { op: 'assign'; id: string; files: string[] }
	| { op: 'reorder'; ids: string[] };

export interface OutlineChanges {
	added: string[];
	renamed: string[];
	/** Sections that absorbed others; `removed` are the ids merged into `into`. */
	merged: { into: string; removed: string[] }[];
	/** Sections that were given more source files. */
	assigned: string[];
	reordered: boolean;
	/** Sections dropped because none of their source files has a clean twin any more. */
	dropped: string[];
}

export const noChanges = (): OutlineChanges => ({
	added: [],
	renamed: [],
	merged: [],
	assigned: [],
	reordered: false,
	dropped: [],
});

class Invalid extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function title(v: unknown): string {
	if (typeof v !== 'string' || !v.trim()) throw new Invalid('title must be a non-empty string');
	return v.trim();
}

function ids(v: unknown, what: string): string[] {
	if (!Array.isArray(v) || v.length === 0 || v.some(x => typeof x !== 'string')) {
		throw new Invalid(`${what} must be a non-empty array of strings`);
	}
	return [...new Set(v as string[])];
}

function parseOp(v: unknown): DeltaOp {
	if (!isObject(v)) throw new Invalid('each op must be an object');
	switch (v.op) {
		case 'add': {
			if (v.after !== undefined && v.after !== null && typeof v.after !== 'string') throw new Invalid('after must be a section id');
			const op: DeltaOp = { op: 'add', title: title(v.title), files: ids(v.files, 'files') };
			if (typeof v.after === 'string') op.after = v.after;
			return op;
		}
		case 'rename':
			if (typeof v.id !== 'string') throw new Invalid('rename needs an id');
			return { op: 'rename', id: v.id, title: title(v.title) };
		case 'merge': {
			const list = ids(v.ids, 'ids');
			if (list.length < 2) throw new Invalid('merge needs at least two section ids');
			return v.title === undefined ? { op: 'merge', ids: list } : { op: 'merge', ids: list, title: title(v.title) };
		}
		case 'assign':
			if (typeof v.id !== 'string') throw new Invalid('assign needs an id');
			return { op: 'assign', id: v.id, files: ids(v.files, 'files') };
		case 'reorder':
			return { op: 'reorder', ids: ids(v.ids, 'ids') };
		default:
			throw new Invalid(`unknown op ${JSON.stringify(v.op)}`);
	}
}

export type DeltaResult =
	| { ok: true; outline: TextbookOutline; changes: OutlineChanges }
	| { ok: false; error: string };

/** Drops source files that have no clean twin any more, and sections left without any file. */
export function pruneOutline(outline: TextbookOutline, fileIds: string[]): { outline: TextbookOutline; dropped: string[] } {
	const known = new Set(fileIds);
	const dropped: string[] = [];
	const sections: Section[] = [];
	for (const s of [...outline.sections].sort((a, b) => a.order - b.order)) {
		const files = s.sourceFileIds.filter(f => known.has(f));
		if (files.length === 0) dropped.push(s.id);
		else sections.push(files.length === s.sourceFileIds.length ? s : { ...s, sourceFileIds: files });
	}
	return { outline: { version: 1, sections: sections.map((s, i) => (s.order === i ? s : { ...s, order: i })) }, dropped };
}

/**
 * Validates a model reply and applies it to `outline`. Ops are applied in a fixed order whatever
 * order the model listed them in: merge, rename, assign, reorder (existing sections), then add.
 * After the delta every file in `fileIds` must belong to at least one section.
 */
export function applyDelta(
	content: string,
	outline: TextbookOutline,
	fileIds: string[],
	newId: () => string,
): DeltaResult {
	let data: unknown;
	try {
		data = JSON.parse(content.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
	} catch {
		return { ok: false, error: 'not valid JSON' };
	}
	const list = isObject(data) ? data.ops : Array.isArray(data) ? data : undefined;
	if (!Array.isArray(list)) return { ok: false, error: 'expected {"ops": [...]}' };
	try {
		return { ok: true, ...apply(list.map(parseOp), outline, fileIds, newId) };
	} catch (e) {
		if (e instanceof Invalid) return { ok: false, error: e.message };
		throw e;
	}
}

function apply(ops: DeltaOp[], outline: TextbookOutline, fileIds: string[], newId: () => string) {
	const changes = noChanges();
	const known = new Set(fileIds);
	const checkFiles = (files: string[]) => {
		for (const f of files) if (!known.has(f)) throw new Invalid(`unknown file id ${JSON.stringify(f)}`);
	};
	let sections: Section[] = [...outline.sections].sort((a, b) => a.order - b.order).map(s => ({ ...s, sourceFileIds: [...s.sourceFileIds] }));
	const byId = (id: string) => {
		const s = sections.find(x => x.id === id);
		if (!s) throw new Invalid(`unknown section id ${JSON.stringify(id)}`);
		return s;
	};
	const of = <T extends DeltaOp['op']>(op: T) => ops.filter((o): o is Extract<DeltaOp, { op: T }> => o.op === op);

	for (const op of of('merge')) {
		const [keep, ...rest] = op.ids.map(byId);
		for (const s of rest) for (const f of s.sourceFileIds) if (!keep.sourceFileIds.includes(f)) keep.sourceFileIds.push(f);
		if (op.title !== undefined && op.title !== keep.title) keep.title = op.title;
		sections = sections.filter(s => !rest.includes(s));
		changes.merged.push({ into: keep.id, removed: rest.map(s => s.id) });
	}
	for (const op of of('rename')) {
		const s = byId(op.id);
		if (s.title !== op.title) {
			s.title = op.title;
			if (!changes.renamed.includes(s.id)) changes.renamed.push(s.id);
		}
	}
	for (const op of of('assign')) {
		checkFiles(op.files);
		const s = byId(op.id);
		const extra = op.files.filter(f => !s.sourceFileIds.includes(f));
		if (extra.length > 0) {
			s.sourceFileIds = [...s.sourceFileIds, ...extra];
			if (!changes.assigned.includes(s.id)) changes.assigned.push(s.id);
		}
	}
	const reorders = of('reorder');
	if (reorders.length > 1) throw new Invalid('at most one reorder op');
	if (reorders.length === 1) {
		const order = reorders[0].ids;
		if (order.length !== sections.length || !sections.every(s => order.includes(s.id))) {
			throw new Invalid('reorder must list every existing section id exactly once');
		}
		const next = order.map(byId);
		changes.reordered = next.some((s, i) => s !== sections[i]);
		sections = next;
	}
	const existing = new Set(sections.map(s => s.id));
	for (const op of of('add')) {
		checkFiles(op.files);
		const section: Section = { id: newId(), title: op.title, sourceFileIds: op.files, order: 0 };
		if (op.after === undefined) sections.push(section);
		else {
			if (!existing.has(op.after)) throw new Invalid(`unknown section id ${JSON.stringify(op.after)}`);
			// After the anchor and after any sections already added behind it, so adds keep their listed order.
			let at = sections.findIndex(s => s.id === op.after) + 1;
			while (at < sections.length && changes.added.includes(sections[at].id)) at++;
			sections.splice(at, 0, section);
		}
		changes.added.push(section.id);
	}

	const covered = new Set(sections.flatMap(s => s.sourceFileIds));
	const missing = fileIds.filter(f => !covered.has(f));
	if (missing.length > 0) throw new Invalid(`no section has file ${missing.map(f => JSON.stringify(f)).join(', ')}`);

	return {
		outline: { version: 1 as const, sections: sections.map((s, i) => ({ ...s, order: i })) },
		changes,
	};
}
