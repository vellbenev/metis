// The clean prompt (SPEC 6.4). One request per batch of adjacent new/changed raw blocks.

import type { BlockId } from '../core/blocks';
import type { ChatMessage, Enrichment } from '../provider/types';
import type { RewriteLevel } from '../vault/types';

export interface CleanPromptBlock {
	id: BlockId;
	/** The normalised raw text of the block, inline formatting as simple Markdown. */
	text: string;
	/** For a changed block that was cleaned before: its normalised raw text at that clean. */
	previousRaw?: string;
	/** For a changed block that was cleaned before: its previous clean text. */
	previousClean?: string;
}

export interface CleanPromptInput {
	blocks: CleanPromptBlock[];
	/** Neighbouring clean blocks, read-only context. */
	contextBefore: string[];
	contextAfter: string[];
	rewriteLevel: RewriteLevel;
	enrichment: Enrichment;
}

const LEVELS: Record<RewriteLevel, string> = {
	light: 'light: fix only typos, spacing and ZWNJ (نیم‌فاصله). Keep every sentence as written.',
	structure:
		'structure: tidy the sentences into semi-formal written Persian, and use headings and lists where the notes are already shaped that way.',
	full: 'full: rewrite the sentences for flow in semi-formal written Persian.',
};

const ENRICHMENT: Record<Enrichment, string> = {
	off: 'Never add any words of your own. Do not use <ai> tags.',
	'flag-gaps': 'Never add any words of your own. Do not use <ai> tags.',
	'light-add':
		'You may complete an incomplete sentence with a few words, only inside that sentence, wrapped in <ai>...</ai>. Never add a new heading or a new paragraph, and never a whole sentence.',
};

export function cleanSystemPrompt(rewriteLevel: RewriteLevel, enrichment: Enrichment): string {
	return [
		'You clean up messy Persian study notes. The notes are the only source of truth.',
		'Rules:',
		'- Be faithful: never add a claim, fact or example the user did not write. Do not drop anything the user wrote.',
		`- Rewrite level ${LEVELS[rewriteLevel]}`,
		'- Write semi-formal Persian; turn colloquial speech into clean written Persian without changing the meaning.',
		'- Keep Latin technical terms in Latin exactly as written (for example zk-SNARK, prover); never translate or transliterate them.',
		'- Leave URLs, code and digits exactly as written; never change, translate or convert them.',
		'- Use correct ZWNJ (نیم‌فاصله), for example می‌رود, کتاب‌ها. Join ای, ام, ات, اش with ZWNJ only where they are suffixes of the word before (خانه‌ای, خسته‌ام, خانه‌ات, خانه‌اش); keep them separate where they are words of their own (for example the vocative ای in ای خدا).',
		'- Inline formatting is simple Markdown: `code`, **bold**, *italic*; a backslash escapes a literal \\, ` or *. Keep this formatting in your output, and copy every `code` span byte for byte.',
		'- Wrap any unclear or incomplete part of the notes in <gap>...</gap> instead of guessing what was meant.',
		`- ${ENRICHMENT[enrichment]}`,
		'- A block with "previousClean" was cleaned before and the user edited it since. "previousRaw" (when present) is its text at that time and "previousClean" is how it was cleaned: compare "previousRaw" with "text", and keep the wording of previousClean for every part that did not change.',
		'- "contextBefore" and "contextAfter" are already-cleaned neighbouring blocks. Read them for context only; never output them.',
		'Input: a JSON object with "blocks" (each with "id" and "text"), "contextBefore" and "contextAfter".',
		'Output: only a JSON object {"blocks": [...]}, no other text. Each output block is one of:',
		'  {"type": "paragraph", "text": "...", "sources": ["<id>"]}',
		'  {"type": "heading", "level": 1 | 2 | 3, "text": "...", "sources": ["<id>"]}',
		'  {"type": "bulletList" | "orderedList", "items": ["...", "..."], "sources": ["<id>"]}',
		'  {"type": "blockquote", "text": "...", "sources": ["<id>"]}',
		'"sources" lists the ids of the input blocks the output block comes from (only ids from "blocks"). Keep the order of the input.',
	].join('\n');
}

export function cleanMessages(input: CleanPromptInput): ChatMessage[] {
	const payload = {
		blocks: input.blocks.map(b => ({
			id: b.id,
			text: b.text,
			...(b.previousRaw === undefined ? {} : { previousRaw: b.previousRaw }),
			...(b.previousClean === undefined ? {} : { previousClean: b.previousClean }),
		})),
		contextBefore: input.contextBefore,
		contextAfter: input.contextAfter,
	};
	return [
		{ role: 'system', content: cleanSystemPrompt(input.rewriteLevel, input.enrichment) },
		{ role: 'user', content: JSON.stringify(payload) },
	];
}

export function retryMessages(first: ChatMessage[], reply: string, error: string): ChatMessage[] {
	return [
		...first,
		{ role: 'assistant', content: reply },
		{
			role: 'user',
			content: `That reply was invalid: ${error}. Reply again with only the JSON object {"blocks": [...]} following the rules.`,
		},
	];
}
