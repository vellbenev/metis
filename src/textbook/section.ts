// Validation of a generated textbook section and conversion to TipTap JSON with provenance marks (I4):
// every text span is `rewrite` or `aiAdded`; unclear spans also carry `gap`.

import type { JSONNode } from '../core/blocks';
import type { Enrichment } from '../provider/types';

type Inline = { text: string; ai: boolean; gap: boolean }[];

export type SectionBlock =
	| { type: 'paragraph' | 'blockquote'; text: Inline }
	| { type: 'heading'; text: Inline }
	| { type: 'bulletList' | 'orderedList'; items: Inline[] }
	| { type: 'codeBlock'; code: string };

export type SectionResult = { ok: true; blocks: SectionBlock[]; gaps: string[] } | { ok: false; error: string };

class Invalid extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Parses inline <gap> and <ai> tags (not nested). */
function parseInline(value: unknown, allowAi: boolean): Inline {
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
	if (spans.some(s => s.ai) && !allowAi) throw new Invalid('<ai> is not allowed here');
	// A block made only of added text would be a new paragraph or item, which is never allowed.
	if (!spans.some(s => !s.ai && s.text.trim())) throw new Invalid('a block needs text from the notes');
	return spans;
}

function parseBlock(v: unknown, enrichment: Enrichment): SectionBlock {
	if (!isObject(v)) throw new Invalid('each block must be an object');
	const ai = enrichment === 'light-add';
	switch (v.type) {
		case 'paragraph':
		case 'blockquote':
			return { type: v.type, text: parseInline(v.text, ai) };
		case 'heading':
			// The model may keep a heading from the notes, never add one: no <ai> in headings.
			return { type: 'heading', text: parseInline(v.text, false) };
		case 'bulletList':
		case 'orderedList':
			if (!Array.isArray(v.items) || v.items.length === 0) throw new Invalid('items must be a non-empty array');
			return { type: v.type, items: v.items.map(i => parseInline(i, ai)) };
		case 'codeBlock':
			if (typeof v.text !== 'string' || !v.text.trim()) throw new Invalid('code must be a non-empty string');
			return { type: 'codeBlock', code: v.text };
		default:
			throw new Invalid(`unknown block type ${JSON.stringify(v.type)}`);
	}
}

/** Validates a model reply for one section: {"blocks": [...], "gaps": ["..."]}. */
export function parseSectionOutput(content: string, enrichment: Enrichment): SectionResult {
	let data: unknown;
	try {
		data = JSON.parse(content.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
	} catch {
		return { ok: false, error: 'not valid JSON' };
	}
	if (!isObject(data) || !Array.isArray(data.blocks)) return { ok: false, error: 'expected {"blocks": [...], "gaps": [...]}' };
	if (data.blocks.length === 0) return { ok: false, error: 'no blocks' };
	const rawGaps = data.gaps ?? [];
	if (!Array.isArray(rawGaps) || rawGaps.some(g => typeof g !== 'string')) {
		return { ok: false, error: 'gaps must be an array of strings' };
	}
	try {
		const blocks = data.blocks.map(b => parseBlock(b, enrichment));
		return { ok: true, blocks, gaps: (rawGaps as string[]).map(g => g.trim()).filter(Boolean) };
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

/** A section's blocks as a TipTap doc; every top-level node gets an id. */
export function sectionDoc(blocks: SectionBlock[], newId: () => string): JSONNode {
	const content = blocks.map((b): JSONNode => {
		const attrs = { id: newId() };
		switch (b.type) {
			case 'paragraph':
				return { type: 'paragraph', attrs, content: inlineNodes(b.text) };
			case 'heading':
				// Level 3: the section title itself is the level-2 heading.
				return { type: 'heading', attrs: { ...attrs, level: 3 }, content: inlineNodes(b.text) };
			case 'blockquote':
				return { type: 'blockquote', attrs, content: [paragraph(b.text)] };
			case 'bulletList':
			case 'orderedList':
				return { type: b.type, attrs, content: b.items.map(i => ({ type: 'listItem', content: [paragraph(i)] })) };
			case 'codeBlock':
				return { type: 'codeBlock', attrs, content: [{ type: 'text', text: b.code, marks: [REWRITE] }] };
		}
	});
	return { type: 'doc', content };
}

/** Gap notes for a section: the model's list, then every `gap` span in the text, without repeats. */
export function sectionGaps(blocks: SectionBlock[], modelGaps: string[]): string[] {
	const spans = blocks.flatMap(b => {
		if (b.type === 'codeBlock') return [];
		if ('items' in b) return b.items.flat();
		return b.text;
	});
	const out: string[] = [];
	for (const note of [...modelGaps, ...spans.filter(s => s.gap).map(s => s.text.trim())]) {
		if (note && !out.includes(note)) out.push(note);
	}
	return out;
}
