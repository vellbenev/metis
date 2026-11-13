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

/** Common words and abbreviations that are not technical terms (compared lowercase, dots removed). */
export const TERM_STOPLIST: ReadonlySet<string> = new Set(['ok', 'okay', 'eg', 'ie', 'etc', 'vs', 'aka', 'btw', 'fyi', 'cf', 'via', 'et', 'al']);

/**
 * Whether a matched Latin word counts as a technical term: at least 3 characters, two Latin letters in a
 * row somewhere (so `v1.2`, `e.g` and `x2` have no word shape), and not on the stoplist.
 */
function isTerm(word: string): boolean {
	if (word.length < 3) return false;
	if (!new RegExp(`[${LATIN}]{2}`, 'u').test(word)) return false;
	return !TERM_STOPLIST.has(word.toLowerCase().replace(/\./g, ''));
}

/**
 * The Latin technical terms in a block, which the clean output must keep (SPEC 6.4). A term is a
 * Latin word as matched by TERM that passes `isTerm`. Inline code spans (already checked byte for
 * byte), URLs and e-mail addresses are skipped. Repeats are dropped case-insensitively; the first
 * spelling is kept.
 */
export function latinTerms(block: JSONNode): string[] {
	const text = termText(block).replace(URL_OR_EMAIL, ' ');
	const out = new Map<string, string>();
	for (const [term] of text.matchAll(TERM)) {
		if (isTerm(term) && !out.has(term.toLowerCase())) out.set(term.toLowerCase(), term);
	}
	return [...out.values()];
}

/** English singular of a word, by the regular plural rules only (proofs, hashes, properties). */
function singular(word: string): string {
	if (/[^aeiou]ies$/i.test(word) && word.length > 4) return `${word.slice(0, -3)}y`;
	if (/(?:s|x|z|ch|sh)es$/i.test(word)) return word.slice(0, -2);
	if (/[^s]s$/i.test(word) && word.length > 3) return word.slice(0, -1);
	return word;
}

/** The spellings that satisfy a term: the term, its singular, and the regular plurals of that singular. */
function termForms(term: string): string[] {
	const one = singular(term);
	const forms = [term, one, `${one}s`, `${one}es`];
	if (/[^aeiou]y$/i.test(one)) forms.push(`${one.slice(0, -1)}ies`);
	return [...new Set(forms)];
}

/**
 * Terms that do not occur in `text` as a whole Latin word. Case and hyphen variants (– for -) are
 * accepted, and so is anything non-Latin around a term: a Persian suffix with or without ZWNJ
 * (prover‌ها), punctuation, or formatting already removed from `text`. Singular and English plural
 * count as the same term both ways (provers is kept by prover‌ها, prover by provers).
 */
export function missingTerms(text: string, terms: string[]): string[] {
	const haystack = text.replace(HYPHENS, '-');
	const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return terms.filter(term => {
		const forms = termForms(term).map(escape).join('|');
		return !new RegExp(`(?<![${LATIN}0-9])(?:${forms})(?![${LATIN}0-9])`, 'iu').test(haystack);
	});
}
