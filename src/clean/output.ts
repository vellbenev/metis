// Validation of the model's clean output (SPEC 6.2 step 5) and conversion to TipTap JSON with
// provenance marks (I4): every text span is `rewrite` or `aiAdded`; unclear spans also carry `gap`.

import type { BlockId, JSONNode } from '../core/blocks';
import type { Enrichment } from '../provider/types';

type Inline = { text: string; ai: boolean; gap: boolean }[];

export type CleanBlockSpec =
	| { type: 'paragraph' | 'blockquote'; text: Inline; sources: BlockId[] }
	| { type: 'heading'; level: number; text: Inline; sources: BlockId[] }
	| { type: 'bulletList' | 'orderedList'; items: Inline[]; sources: BlockId[] };

export type ParseResult = { ok: true; blocks: CleanBlockSpec[] } | { ok: false; error: string };

class Invalid extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Parses inline <gap> and <ai> tags (not nested). */
function parseInline(value: unknown, enrichment: Enrichment): Inline {
	if (typeof value !== 'string') throw new Invalid('text must be a string');
	const spans: Inline = [];
	let open: 'gap' | 'ai' | undefined;
	let last = 0;
	const push = (text: string) => {
		if (text) spans.push({ text, ai: open === 'ai', gap: open === 'gap' });
	};
	for (const m of value.matchAll(/<(\/?)(gap|ai)>/g)) {
		push(value.slice(last, m.index));
		last = m.index! + m[0].length;
		const [, closing, tag] = m;
		if (closing ? open !== tag : open !== undefined) throw new Invalid(`unbalanced <${tag}> tag`);
		open = closing ? undefined : (tag as 'gap' | 'ai');
	}
	if (open) throw new Invalid(`unclosed <${open}> tag`);
	push(value.slice(last));
	if (spans.some(s => s.ai) && enrichment !== 'light-add') throw new Invalid('<ai> is not allowed in this mode');
	if (!spans.some(s => !s.ai && s.text.trim())) throw new Invalid('a block needs text from the notes');
	return spans;
}

function parseBlock(value: unknown, batchIds: Set<BlockId>, enrichment: Enrichment): CleanBlockSpec {
	if (!isObject(value)) throw new Invalid('each block must be an object');
	const { sources } = value;
	if (!Array.isArray(sources) || sources.length === 0) throw new Invalid('sources must be a non-empty array');
	for (const id of sources) {
		if (typeof id !== 'string' || !batchIds.has(id)) throw new Invalid(`unknown source id ${JSON.stringify(id)}`);
	}
	const src = [...new Set(sources as string[])];
	switch (value.type) {
		case 'paragraph':
		case 'blockquote':
			return { type: value.type, text: parseInline(value.text, enrichment), sources: src };
		case 'heading': {
			const level = value.level ?? 2;
			if (level !== 1 && level !== 2 && level !== 3) throw new Invalid('heading level must be 1, 2 or 3');
			return { type: 'heading', level, text: parseInline(value.text, enrichment), sources: src };
		}
		case 'bulletList':
		case 'orderedList': {
			if (!Array.isArray(value.items) || value.items.length === 0) throw new Invalid('items must be a non-empty array');
			return { type: value.type, items: value.items.map(i => parseInline(i, enrichment)), sources: src };
		}
		default:
			throw new Invalid(`unknown block type ${JSON.stringify(value.type)}`);
	}
}

/** Validates a model reply: schema, source ids from the batch only, no empty output. */
export function parseCleanOutput(content: string, batchIds: BlockId[], enrichment: Enrichment): ParseResult {
	let data: unknown;
	try {
		data = JSON.parse(content.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
	} catch {
		return { ok: false, error: 'not valid JSON' };
	}
	const list = Array.isArray(data) ? data : isObject(data) ? data.blocks : undefined;
	if (!Array.isArray(list)) return { ok: false, error: 'expected {"blocks": [...]}' };
	if (list.length === 0) return { ok: false, error: 'no blocks' };
	try {
		const ids = new Set(batchIds);
		return { ok: true, blocks: list.map(b => parseBlock(b, ids, enrichment)) };
	} catch (e) {
		if (e instanceof Invalid) return { ok: false, error: e.message };
		throw e;
	}
}

// ---- TipTap JSON -------------------------------------------------------------------------------

export const REWRITE = { type: 'rewrite' };
export const AI_ADDED = { type: 'aiAdded', attrs: { accepted: false } };
export const GAP = { type: 'gap' };

function inlineNodes(spans: Inline): JSONNode[] {
	return spans.map(s => ({
		type: 'text',
		text: s.text,
		marks: s.ai ? [AI_ADDED] : s.gap ? [REWRITE, GAP] : [REWRITE],
	}));
}

const paragraph = (spans: Inline): JSONNode => ({ type: 'paragraph', content: inlineNodes(spans) });

/** A clean block as a top-level TipTap node with `id`, `sources` and `changedIn`. */
export function specToNode(spec: CleanBlockSpec, id: BlockId, changedIn: number): JSONNode {
	const attrs = { id, sources: spec.sources, changedIn };
	switch (spec.type) {
		case 'paragraph':
			return { type: 'paragraph', attrs, content: inlineNodes(spec.text) };
		case 'heading':
			return { type: 'heading', attrs: { ...attrs, level: spec.level }, content: inlineNodes(spec.text) };
		case 'blockquote':
			return { type: 'blockquote', attrs, content: [paragraph(spec.text)] };
		case 'bulletList':
		case 'orderedList':
			return {
				type: spec.type,
				attrs,
				content: spec.items.map(item => ({ type: 'listItem', content: [paragraph(item)] })),
			};
	}
}

/** A verbatim copy of a raw block (code, horizontal rule, ...) as a clean block; its text is marked `rewrite`. */
export function verbatimNode(raw: JSONNode, id: BlockId, source: BlockId, changedIn: number): JSONNode {
	const mark = (node: JSONNode): JSONNode => {
		const out: JSONNode = { ...node };
		if (typeof node.text === 'string') out.marks = [...(node.marks ?? []), REWRITE];
		if (node.content) out.content = node.content.map(mark);
		return out;
	};
	const copy = mark(structuredClone(raw));
	return { ...copy, attrs: { ...copy.attrs, id, sources: [source], changedIn } };
}
