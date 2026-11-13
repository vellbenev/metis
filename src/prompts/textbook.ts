// The textbook prompts (SPEC section 7): one request for the outline delta, then one per stale section.
// Input is clean twins only, never raw notes.

import type { ChatMessage, Enrichment } from '../provider/types';

export interface OutlinePromptInput {
	outline: { id: string; title: string; files: string[] }[];
	/** Every clean twin. New or changed ones come with their text, the others with their headings only. */
	files: { fileId: string; changed: boolean; headings: string[]; text?: string }[];
}

export interface SectionPromptInput {
	title: string;
	/** Titles of all sections in order, so this section stays on its own topic. */
	outline: string[];
	files: { fileId: string; text: string }[];
	enrichment: Enrichment;
}

const COMMON = [
	'The notes are Persian study notes that were already cleaned up. They are the only source of truth.',
	'Keep Latin technical terms in Latin exactly as written (for example zk-SNARK, prover); never translate or transliterate them.',
	'Use correct ZWNJ (نیم‌فاصله), for example می‌رود, کتاب‌ها.',
];

export function outlineSystemPrompt(): string {
	return [
		'You keep the outline (table of contents) of a Persian textbook built from a set of note files.',
		...COMMON,
		'The outline is stable: propose only a small delta, and an empty delta when the outline already fits.',
		'Never rename, merge or reorder sections without a clear reason in the notes. Section titles are short and in Persian.',
		'Every file must belong to at least one section. A new or changed file goes into an existing section (assign) or a new one (add).',
		'Input: a JSON object with "outline" (current sections: "id", "title", "files") and "files" (each with "fileId", "changed", "headings", and "text" when changed).',
		'Output: only a JSON object {"ops": [...]}, no other text. Each op is one of:',
		'  {"op": "add", "title": "...", "files": ["<fileId>"], "after": "<section id>"}   ("after" is optional; without it the section goes last)',
		'  {"op": "rename", "id": "<section id>", "title": "..."}',
		'  {"op": "merge", "ids": ["<kept section id>", "<section id>", ...], "title": "..."}   ("title" is optional)',
		'  {"op": "assign", "id": "<section id>", "files": ["<fileId>"]}',
		'  {"op": "reorder", "ids": ["<every existing section id in the new order>"]}',
		'Use only section ids and file ids from the input. Never invent ids.',
	].join('\n');
}

const ENRICHMENT: Record<Enrichment, string> = {
	off: 'Never add any words of your own. Do not use <ai> tags.',
	'flag-gaps': 'Never add any words of your own. Do not use <ai> tags.',
	'light-add':
		'You may complete an incomplete sentence with a few words, only inside that sentence, wrapped in <ai>...</ai>. Never add a section, a heading, a paragraph, a list item or a whole sentence.',
};

export function sectionSystemPrompt(enrichment: Enrichment): string {
	return [
		'You write one section of a Persian textbook from the user\'s notes.',
		...COMMON,
		'Rules:',
		'- Strict: every statement comes from the notes. Never add a claim, fact or example that is not in the notes.',
		'- Write only about this section\'s title; other sections of the outline cover the rest of the notes.',
		'- Write semi-formal Persian and organise the material for study; you may keep sub-headings that the notes already have.',
		'- Wrap any unclear or incomplete part of the notes in <gap>...</gap> instead of guessing, and list what is missing or unclear in "gaps".',
		`- ${ENRICHMENT[enrichment]}`,
		'Input: a JSON object with "title", "outline" (all section titles) and "files" (each with "fileId" and "text").',
		'Output: only a JSON object {"blocks": [...], "gaps": ["..."]}, no other text. Each block is one of:',
		'  {"type": "paragraph", "text": "..."}',
		'  {"type": "heading", "text": "..."}',
		'  {"type": "bulletList" | "orderedList", "items": ["...", "..."]}',
		'  {"type": "blockquote", "text": "..."}',
		'  {"type": "codeBlock", "text": "..."}',
	].join('\n');
}

export function outlineMessages(input: OutlinePromptInput): ChatMessage[] {
	return [
		{ role: 'system', content: outlineSystemPrompt() },
		{ role: 'user', content: JSON.stringify(input) },
	];
}

export function sectionMessages(input: SectionPromptInput): ChatMessage[] {
	const { enrichment, ...payload } = input;
	return [
		{ role: 'system', content: sectionSystemPrompt(enrichment) },
		{ role: 'user', content: JSON.stringify(payload) },
	];
}

export function retryMessages(first: ChatMessage[], reply: string, error: string, shape: string): ChatMessage[] {
	return [
		...first,
		{ role: 'assistant', content: reply },
		{ role: 'user', content: `That reply was invalid: ${error}. Reply again with only the JSON object ${shape} following the rules.` },
	];
}
