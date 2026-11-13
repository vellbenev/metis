import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadFixture, textToDoc } from '../test/fixtures';
import { blockIds, canonicalHash, canonicalJSON, type JSONNode } from './blocks';

const para = (text: string, attrs?: Record<string, unknown>): JSONNode => ({
	type: 'paragraph',
	...(attrs ? { attrs } : {}),
	content: [{ type: 'text', text }],
});

describe('canonicalJSON', () => {
	it('drops attrs.id and then the empty attrs object', () => {
		expect(canonicalJSON(para('سلام', { id: 'abcdefghijkl' }))).toBe(canonicalJSON(para('سلام')));
		expect(canonicalJSON(para('سلام', { id: 'abcdefghijkl' }))).toBe(
			'{"content":[{"text":"سلام","type":"text"}],"type":"paragraph"}',
		);
	});

	it('omits null and undefined attributes but keeps other values', () => {
		const a: JSONNode = { type: 'heading', attrs: { id: 'x', level: 2, textAlign: null, foo: undefined } };
		expect(canonicalJSON(a)).toBe('{"attrs":{"level":2},"type":"heading"}');
		const b: JSONNode = { type: 'paragraph', attrs: { id: 'x', textAlign: null } };
		expect(canonicalJSON(b)).toBe('{"type":"paragraph"}');
	});

	it('sorts keys at every level and keeps array order', () => {
		const block: JSONNode = {
			type: 'paragraph',
			content: [
				{ type: 'text', text: 'b', marks: [{ type: 'italic' }, { type: 'bold' }] },
				{ type: 'text', text: 'a' },
			],
		};
		expect(canonicalJSON(block)).toBe(
			'{"content":[{"marks":[{"type":"italic"},{"type":"bold"}],"text":"b","type":"text"},{"text":"a","type":"text"}],"type":"paragraph"}',
		);
	});

	it('applies the attrs rules to nested nodes and marks, removing id only at the top level', () => {
		const list: JSONNode = {
			type: 'bulletList',
			attrs: { id: 'top' },
			content: [
				{
					type: 'listItem',
					attrs: { checked: null },
					content: [
						{
							type: 'paragraph',
							attrs: { id: 'nested' },
							content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'h', target: null } }] }],
						},
					],
				},
			],
		};
		expect(canonicalJSON(list)).toBe(
			'{"content":[{"content":[{"attrs":{"id":"nested"},"content":[{"marks":[{"attrs":{"href":"h"},"type":"link"}],"text":"x","type":"text"}],"type":"paragraph"}],"type":"listItem"}],"type":"bulletList"}',
		);
	});

	it('does not mutate the input', () => {
		const block = para('x', { id: 'abc', level: null });
		const copy = structuredClone(block);
		canonicalJSON(block);
		expect(block).toEqual(copy);
	});
});

describe('canonicalHash', () => {
	it('is sha256 hex of the UTF-8 canonical JSON', async () => {
		const block = para('کتاب‌ها و zk-SNARK', { id: 'abcdefghijkl' });
		const expected = createHash('sha256').update(canonicalJSON(block), 'utf8').digest('hex');
		expect(await canonicalHash(block)).toBe(expected);
		expect(expected).toMatch(/^[0-9a-f]{64}$/);
	});

	it('hashes a block the same with attrs: {id} as without attrs', async () => {
		expect(await canonicalHash(para('سلام', { id: 'abcdefghijkl' }))).toBe(await canonicalHash(para('سلام')));
	});

	it('does not depend on block id or key order', async () => {
		const a = { type: 'heading', attrs: { level: 1, id: 'one' }, content: [{ type: 'text', text: 'x' }] };
		const b = { content: [{ text: 'x', type: 'text' }], attrs: { id: 'two', level: 1 }, type: 'heading' };
		expect(await canonicalHash(a)).toBe(await canonicalHash(b));
	});

	it('changes when text, ZWNJ, or mark order changes', async () => {
		const base = await canonicalHash(para('کتاب‌ها'));
		expect(await canonicalHash(para('کتاب ها'))).not.toBe(base);
		const m1 = { type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'bold' }, { type: 'italic' }] }] };
		const m2 = { type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'italic' }, { type: 'bold' }] }] };
		expect(await canonicalHash(m1)).not.toBe(await canonicalHash(m2));
	});
});

describe('fixtures', () => {
	it.each(['zkp-01-basics.txt', 'zkp-01-basics.day2.txt', 'zkp-02-snark.txt'])('loads persian/%s', async name => {
		const text = loadFixture(`persian/${name}`);
		expect(text.length).toBeGreaterThan(0);
		const doc = textToDoc(text);
		expect(doc.content!.length).toBeGreaterThan(0);
		expect(blockIds(doc).every(id => id === undefined)).toBe(true);
		for (const block of doc.content!) expect(await canonicalHash(block)).toMatch(/^[0-9a-f]{64}$/);
	});
});
