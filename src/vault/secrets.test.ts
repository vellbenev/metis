import { describe, expect, it } from 'vitest';
import { assertNoSecrets } from './secrets';

describe('assertNoSecrets (I5)', () => {
	it('rejects keys that name a secret anywhere in the key, at any depth', () => {
		const keys = [
			'apiKey',
			'api_key',
			'API-KEY',
			'openaiApiKey',
			'x-api-key',
			'apiKeys',
			'token',
			'refreshToken',
			'clientSecret',
			'password',
			'Authorization',
			'bearer',
		];
		for (const key of keys) {
			expect(() => assertNoSecrets({ [key]: 'x' }), key).toThrow(/secret/);
			expect(() => assertNoSecrets({ a: [{ b: { [key]: 'x' } }] }), key).toThrow(/\$\.a\[0\]\.b/);
		}
	});

	it('accepts ordinary notes and derived data, whatever the text says', () => {
		const doc = {
			type: 'doc',
			content: [
				{ type: 'heading', attrs: { id: 'aB3_xY9-kLmN', level: 2, textAlign: 'right' } },
				{
					type: 'paragraph',
					attrs: { id: 'p1', sources: ['a', 'b'], changedIn: 3 },
					content: [
						{ type: 'text', text: 'my apiKey is a token: secret password', marks: [{ type: 'bold' }] },
						{
							type: 'text',
							text: 'zk-SNARK',
							marks: [
								{ type: 'link', attrs: { href: 'x', target: '_blank', rel: 'noopener', class: null } },
								{ type: 'aiAdded', attrs: { accepted: false } },
								{ type: 'gap' },
							],
						},
					],
				},
				{ type: 'codeBlock', attrs: { id: 'c1', language: 'ts' } },
				{ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] },
			],
		};
		expect(() => assertNoSecrets({ version: 1, fileId: 'f', title: 'کلید API', doc })).not.toThrow();
		expect(() =>
			assertNoSecrets({ version: 1, name: 'ZKP', createdAt: 1, defaults: { rewriteLevel: 'structure' } }),
		).not.toThrow();
		expect(() =>
			assertNoSecrets({
				version: 1,
				revision: 2,
				blocks: { id1: { rawHash: 'ab', cleanIds: [], lastRevision: 2 } },
			}),
		).not.toThrow();
	});
});
