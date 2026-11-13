import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JSONNode } from '../core/blocks';

const root = join(import.meta.dirname, '..', '..', 'fixtures');

export function loadFixture(path: string): string {
	return readFileSync(join(root, path), 'utf8');
}

/** Plain text to a TipTap doc: one paragraph per non-empty line, no ids. */
export function textToDoc(text: string): JSONNode {
	const content = text
		.split('\n')
		.map(line => line.trimEnd())
		.filter(line => line.length > 0)
		.map(line => ({ type: 'paragraph', content: [{ type: 'text', text: line }] }));
	return { type: 'doc', content };
}
