// Plain-text views of blocks for the clean prompt. Inline formatting is sent as simple Markdown:
// `code`, **bold**, *italic*; a literal \, ` or * in the text is escaped with a backslash.

import type { JSONNode } from '../core/blocks';

const hasMark = (node: JSONNode, type: string) => node.marks?.some(m => m.type === type) ?? false;

const escape = (text: string) => text.replace(/[\\`*]/g, c => `\\${c}`);

/** A Markdown code span whose fence is longer than any backtick run inside the text. */
function codeSpan(text: string): string {
	const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length));
	const fence = '`'.repeat(longest + 1);
	// As in CommonMark, one space on each side is stripped when reading, so pad when that would bite.
	const spaced = text.startsWith(' ') && text.endsWith(' ') && text.trim() !== '';
	const pad = text.startsWith('`') || text.endsWith('`') || spaced ? ' ' : '';
	return `${fence}${pad}${text}${pad}${fence}`;
}

/**
 * Inline content as text. `gap` and `aiAdded` spans of a clean block are shown as <gap> and <ai> tags.
 * Bold and italic markers are emitted only where the formatting changes, so adjacent spans never
 * produce ambiguous runs such as `*a**b*`.
 */
function inline(nodes: JSONNode[] | undefined): string {
	let out = '';
	let bold = false;
	let italic = false;
	const format = (b: boolean, i: boolean) => {
		if (b !== bold) out += '**';
		if (i !== italic) out += '*';
		bold = b;
		italic = i;
	};
	for (const node of nodes ?? []) {
		if (node.type === 'hardBreak') out += '\n';
		else if (typeof node.text === 'string') {
			format(hasMark(node, 'bold'), hasMark(node, 'italic'));
			let text = hasMark(node, 'code') ? codeSpan(node.text) : escape(node.text);
			if (hasMark(node, 'gap')) text = `<gap>${text}</gap>`;
			if (hasMark(node, 'aiAdded')) text = `<ai>${text}</ai>`;
			out += text;
		} else {
			format(false, false);
			out += inline(node.content);
		}
	}
	format(false, false);
	return out;
}

/** A top-level block as text: `#` for headings, `-` / `1.` for list items, `>` for quotes. */
export function blockText(block: JSONNode): string {
	switch (block.type) {
		case 'paragraph':
			return inline(block.content);
		case 'heading':
			return `${'#'.repeat(Number(block.attrs?.level ?? 1))} ${inline(block.content)}`;
		case 'bulletList':
		case 'orderedList':
			return (block.content ?? [])
				.map((item, i) => {
					const marker = block.type === 'bulletList' ? '-' : `${i + 1}.`;
					return `${marker} ${(item.content ?? []).map(blockText).join('\n  ')}`;
				})
				.join('\n');
		case 'blockquote':
			return (block.content ?? []).map(b => `> ${blockText(b)}`).join('\n');
		default:
			return block.content ? block.content.map(c => (c.type === 'text' ? inline([c]) : blockText(c))).join('') : '';
	}
}

/** The text of every inline `code` span in a block, in document order. */
export function codeSpans(node: JSONNode): string[] {
	if (typeof node.text === 'string') return hasMark(node, 'code') ? [node.text] : [];
	return (node.content ?? []).flatMap(codeSpans);
}

// ---- Latin technical terms -----------------------------------------------------------------------

const LATIN = '\\p{Script=Latin}';
/** A Latin word: starts with a Latin letter; inner `-`, `_` or `.` join parts (zk-SNARK, Node.js, ERC-20). */
const TERM = new RegExp(`(?<![${LATIN}0-9])[${LATIN}][${LATIN}0-9]*(?:[-_.][${LATIN}0-9]+)*`, 'gu');
const URL_OR_EMAIL = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+|\S+@\S+\.\S+/giu;
/** Hyphen-like characters a model may write instead of `-`. */
const HYPHENS = /[‐-―−]/g;

/** Block text for term matching: text nodes joined as is, code spans replaced by a space, blocks by a newline. */
function termText(node: JSONNode): string {
	if (typeof node.text === 'string') return hasMark(node, 'code') ? ' ' : node.text;
	if (node.type === 'hardBreak') return ' ';
	const children = node.content ?? [];
	const inlineOnly = children.every(c => typeof c.text === 'string' || c.type === 'hardBreak');
	return children.map(termText).join(inlineOnly ? '' : '\n');
}

/**
 * The Latin technical terms in a block, which the clean output must keep (SPEC 6.4). A term is a
 * Latin word as matched by TERM. Inline code spans (already checked byte for byte), URLs and e-mail
 * addresses are skipped, and so are single letters (variables such as x or n). Repeats are dropped
 * case-insensitively; the first spelling is kept.
 */
export function latinTerms(block: JSONNode): string[] {
	const text = termText(block).replace(URL_OR_EMAIL, ' ');
	const out = new Map<string, string>();
	for (const [term] of text.matchAll(TERM)) {
		if (term.length > 1 && !out.has(term.toLowerCase())) out.set(term.toLowerCase(), term);
	}
	return [...out.values()];
}

/**
 * Terms that do not occur in `text` as a whole Latin word. Case and hyphen variants (– for -) are
 * accepted, and so is anything non-Latin around a term: a Persian suffix with or without ZWNJ
 * (prover‌ها), punctuation, or formatting already removed from `text`.
 */
export function missingTerms(text: string, terms: string[]): string[] {
	const haystack = text.replace(HYPHENS, '-');
	return terms.filter(term => {
		const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		return !new RegExp(`(?<![${LATIN}0-9])${escaped}(?![${LATIN}0-9])`, 'iu').test(haystack);
	});
}
