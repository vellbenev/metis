import { describe, expect, it } from 'vitest';
import type { JSONNode } from '../core/blocks';
import { loadFixture, textToDoc } from '../test/fixtures';
import { latinTerms, missingTerms } from './text';

const t = (text: string, ...marks: string[]): JSONNode => ({ type: 'text', text, marks: marks.map(type => ({ type })) });
const p = (...content: JSONNode[]): JSONNode => ({ type: 'paragraph', content });

describe('latinTerms', () => {
	it('finds the Latin terms of fixture lines, hyphenated ones as one term', () => {
		const lines = textToDoc(loadFixture('persian/zkp-01-basics.txt')).content!;
		expect(latinTerms(lines[1])).toEqual(['prover', 'verifier']);
		expect(latinTerms(lines[4])).toEqual(['completeness', 'verifier', 'soundness', 'zero', 'knowledge']);
		expect(latinTerms(lines[5])).toEqual(['interactive', 'non-interactive']);
		expect(latinTerms(lines[6])).toEqual(['fiat-shamir', 'hash']);
	});

	it('skips inline code, URLs, e-mail addresses and single letters', () => {
		const block = p(t('ببین '), t('verify(x)', 'code'), t(' در https://example.org/zk-docs و a@b.io برای x و y با Groth16'));
		expect(latinTerms(block)).toEqual(['Groth16']);
	});

	it('reads a term split across formatting as one, and keeps Node.js and ERC-20 whole', () => {
		expect(latinTerms(p(t('zk-'), t('SNARK', 'bold'), t('‌ها')))).toEqual(['zk-SNARK']);
		expect(latinTerms(p(t('با Node.js و ERC-20.')))).toEqual(['Node.js', 'ERC-20']);
	});

	it('skips short tokens, stoplisted words and tokens with no word shape', () => {
		const block = p(t('ok این‌ها e.g. و i.e. و etc. و vs و OK و aka و v1.2 و x2 و ZK و Groth16 و MPC و prover'));
		expect(latinTerms(block)).toEqual(['Groth16', 'MPC', 'prover']);
		expect(latinTerms(p(t('نسخه v2.0.1 و V3 و e2e و a.b.c')))).toEqual([]);
	});

	it('drops case-insensitive repeats and keeps the first spelling', () => {
		expect(latinTerms(p(t('Prover و prover و PROVER')))).toEqual(['Prover']);
	});

	it('separates list items so terms do not run together', () => {
		const list: JSONNode = {
			type: 'bulletList',
			content: [
				{ type: 'listItem', content: [p(t('prover'))] },
				{ type: 'listItem', content: [p(t('verifier'))] },
			],
		};
		expect(latinTerms(list)).toEqual(['prover', 'verifier']);
	});
});

describe('missingTerms', () => {
	it('matches whole Latin words only, ignoring case and hyphen variants', () => {
		expect(missingTerms('prover‌ها و ZK–SNARK', ['prover', 'zk-SNARK'])).toEqual([]);
		expect(missingTerms('reprover و zk-SNARKx', ['prover', 'zk-SNARK'])).toEqual(['prover', 'zk-SNARK']);
		expect(missingTerms('Node.js', ['Node.js', 'Nodexjs'])).toEqual(['Nodexjs']);
	});

	it('treats singular and English plural as the same term, in both directions', () => {
		// Input plural, output singular with a Persian plural suffix (with or without ZWNJ), or bare.
		expect(missingTerms('prover‌ها', ['provers'])).toEqual([]);
		expect(missingTerms('proverها', ['provers'])).toEqual([]);
		expect(missingTerms('prover', ['provers'])).toEqual([]);
		// Input singular, output singular with a suffix or English plural.
		expect(missingTerms('prover‌ها', ['prover'])).toEqual([]);
		expect(missingTerms('provers', ['prover'])).toEqual([]);
		// Other regular plurals.
		expect(missingTerms('hash‌ها و property‌ها و zk-SNARK‌ها', ['hashes', 'properties', 'zk-SNARKs'])).toEqual([]);
		expect(missingTerms('hashes و properties', ['hash', 'property'])).toEqual([]);
		// Still whole words only: a different word that merely contains the term is not it.
		expect(missingTerms('reprovers و proverss و proving', ['provers', 'prover'])).toEqual(['provers', 'prover']);
	});
});
