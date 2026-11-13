// Validation of the model's clean output (SPEC 6.2 step 5) and conversion to TipTap JSON with
// provenance marks (I4): every text span is `rewrite` or `aiAdded`; unclear spans also carry `gap`.
// Inline formatting comes back as simple Markdown (`code`, **bold**, *italic*) and is restored as marks.

import type { BlockId, JSONNode } from '../core/blocks';
import type { Enrichment } from '../provider/types';
import { missingTerms } from './text';

type Span = { text: string; ai: boolean; gap: boolean; bold: boolean; italic: boolean; code: boolean };
type Inline = Span[];

export type CleanBlockSpec =
	| { type: 'paragraph' | 'blockquote'; text: Inline; sources: BlockId[] }
	| { type: 'heading'; level: number; text: Inline; sources: BlockId[] }
	| { type: 'bulletList' | 'orderedList'; items: Inline[]; sources: BlockId[] };

export type ParseResult = { ok: true; blocks: CleanBlockSpec[] } | { ok: false; error: string };

class Invalid extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const TAGS = ['<gap>', '</gap>', '<ai>', '</ai>'];

type StarMarker = { pos: number; len: number };

/**
 * Splits inline text into spans: <gap> and <ai> tags (not nested), and the simple Markdown the
 * prompt uses (`code`, **bold**, *italic*, backslash escapes). A `*` or `**` marker whose position
 * is in `literal` is read as text. Every marker seen is recorded in `markers`.
 */
function tokenize(value: string, literal: Set<number>, markers: StarMarker[] = []): Inline {
	const spans: Inline = [];
	let open: 'gap' | 'ai' | undefined;
	let bold = false;
	let italic = false;
	let buf = '';
	const push = (text: string, code = false) => {
		if (text) spans.push({ text, ai: open === 'ai', gap: open === 'gap', bold, italic, code });
	};
	const flush = () => {
		push(buf);
		buf = '';
	};
	let i = 0;
	while (i < value.length) {
		const c = value[i];
		if (c === '\\' && /[\\`*]/.test(value[i + 1] ?? '')) {
			buf += value[i + 1];
			i += 2;
			continue;
		}
		if (c === '`') {
			const fence = /^`+/.exec(value.slice(i))![0];
			const close = new RegExp(`(?<!\`)${fence}(?!\`)`, 'g');
			close.lastIndex = i + fence.length;
			const m = close.exec(value);
			if (!m) {
				buf += fence;
				i += fence.length;
				continue;
			}
			let code = value.slice(i + fence.length, m.index);
			if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1);
			flush();
			push(code, true);
			i = m.index + fence.length;
			continue;
		}
		if (c === '*') {
			const len = value[i + 1] === '*' ? 2 : 1;
			markers.push({ pos: i, len });
			if (literal.has(i)) buf += value.slice(i, i + len);
			else {
				flush();
				if (len === 2) bold = !bold;
				else italic = !italic;
			}
			i += len;
			continue;
		}
		const tag = TAGS.find(t => value.startsWith(t, i));
		if (tag) {
			flush();
			const closing = tag[1] === '/';
			const name = tag.replace(/[<>/]/g, '') as 'gap' | 'ai';
			if (closing ? open !== name : open !== undefined) throw new Invalid(`unbalanced <${name}> tag`);
			open = closing ? undefined : name;
			i += tag.length;
			continue;
		}
		buf += c;
		i += 1;
	}
	flush();
	if (open) throw new Invalid(`unclosed <${open}> tag`);
	return spans;
}

/**
 * Positions of `*` / `**` markers that have no partner and so are plain text. Like Markdown, a
 * marker can open only before a non-space and close only after a non-space (so `2 * 3` stays text);
 * a closer pairs with the nearest open marker of the same kind. Only unmatched markers fall back to
 * text, so a stray `a*b` does not undo the **bold** around it.
 */
function unmatchedStars(value: string, markers: StarMarker[]): Set<number> {
	const literal = new Set<number>();
	const stacks: Record<number, number[]> = { 1: [], 2: [] };
	const solid = (ch: string | undefined) => ch !== undefined && !/\s/.test(ch);
	for (const { pos, len } of markers) {
		const stack = stacks[len];
		if (solid(value[pos - 1]) && stack.length > 0) stack.pop();
		else if (solid(value[pos + len])) stack.push(pos);
		else literal.add(pos);
	}
	for (const pos of [...stacks[1], ...stacks[2]]) literal.add(pos);
	return literal;
}

function parseInline(value: unknown, enrichment: Enrichment): Inline {
	if (typeof value !== 'string') throw new Invalid('text must be a string');
	const markers: StarMarker[] = [];
	tokenize(value, new Set(), markers);
	const spans = tokenize(value, unmatchedStars(value, markers));
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

const spansOf = (b: CleanBlockSpec): Span[] => ('items' in b ? b.items.flat() : b.text);

/**
 * Inline code must come back byte-identical. A code span the input did not have is turned into
 * plain text; an input code span missing from the output (dropped or altered) makes the output invalid.
 */
function checkCode(blocks: CleanBlockSpec[], inputCode: string[]): void {
	const known = new Set(inputCode);
	const seen = new Set<string>();
	for (const span of blocks.flatMap(spansOf)) {
		if (!span.code) continue;
		if (known.has(span.text)) seen.add(span.text);
		else span.code = false;
	}
	const missing = inputCode.filter(c => !seen.has(c));
	if (missing.length > 0) throw new Invalid(`inline code must be copied exactly: ${missing.map(c => JSON.stringify(c)).join(', ')}`);
}

/** Every Latin term of the batch input must still be in the output (SPEC 6.4); see `missingTerms`. */
function checkTerms(blocks: CleanBlockSpec[], inputTerms: string[]): void {
	const text = blocks.map(b => ('items' in b ? b.items : [b.text]).map(i => i.map(s => s.text).join('')).join('\n')).join('\n');
	const missing = missingTerms(text, inputTerms);
	if (missing.length > 0) throw new Invalid(`Latin terms must be kept as written: ${missing.join(', ')}`);
}

/**
 * Validates a model reply: schema, source ids from the batch only, no empty output, every inline
 * code span of the input (`inputCode`) copied exactly, and every Latin term (`inputTerms`) kept.
 */
export function parseCleanOutput(
	content: string,
	batchIds: BlockId[],
	enrichment: Enrichment,
	inputCode: string[] = [],
	inputTerms: string[] = [],
): ParseResult {
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
		const blocks = list.map(b => parseBlock(b, ids, enrichment));
		// Every raw block of the batch must map to at least one clean block, or its text would vanish.
		const covered = new Set(blocks.flatMap(b => b.sources));
		const missing = batchIds.filter(id => !covered.has(id));
		if (missing.length > 0) throw new Invalid(`no output block has source ${missing.map(id => JSON.stringify(id)).join(', ')}`);
		checkCode(blocks, inputCode);
		checkTerms(blocks, inputTerms);
		return { ok: true, blocks };
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
	return spans.map(s => {
		const marks = s.ai ? [AI_ADDED] : s.gap ? [REWRITE, GAP] : [REWRITE];
		if (s.bold) marks.push({ type: 'bold' });
		if (s.italic) marks.push({ type: 'italic' });
		if (s.code) marks.push({ type: 'code' });
		return { type: 'text', text: s.text, marks };
	});
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
