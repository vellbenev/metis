import { join } from 'node:path';
import { build } from 'vite';
import { describe, expect, it, vi } from 'vitest';
import { DEMO_MARKER, LONG_TITLE } from './demo/seed';
import { loadFixture } from './test/fixtures';

// I6: the built app makes no network requests of its own and loads nothing remote.
describe('production build (I6)', () => {
	it('contains one fetch( call (the provider client) and no remote URL references', async () => {
		// Vitest sets NODE_ENV=test, which would make import.meta.env.DEV true in this build.
		vi.stubEnv('NODE_ENV', 'production');
		const result = await build({
			root: join(import.meta.dirname, '..'),
			logLevel: 'silent',
			build: { write: false, chunkSizeWarningLimit: Infinity },
		}).finally(() => vi.unstubAllEnvs());
		const outputs = (Array.isArray(result) ? result : [result]).flatMap(r => ('output' in r ? r.output : []));
		const files = outputs.map(o => ({
			name: o.fileName,
			text: o.type === 'chunk' ? o.code : typeof o.source === 'string' ? o.source : '',
		}));
		expect(files.some(f => f.name.endsWith('.js'))).toBe(true);
		expect(files.some(f => /vazirmatn.*\.woff2$/.test(f.name))).toBe(true);
		// The only fetch is the provider client's POST to the configured baseUrl (src/provider/openai.ts).
		const fetchCalls = files.flatMap(f => [...f.text.matchAll(/\bfetch\s*\(/g)].map(() => f.name));
		expect(fetchCalls).toHaveLength(1);
		expect(files.find(f => f.name === fetchCalls[0])!.text).toContain('/chat/completions');
		// The dev-only demo mode (src/demo/) and its seed text never reach the production build.
		// (zkp-01-basics.txt is in the build on purpose: the settings model test sends it.)
		const day2 = loadFixture('persian/zkp-01-basics.day2.txt').split('\n')[0];
		for (const f of files) {
			expect(f.name, f.name).not.toMatch(/demo/i);
			for (const marker of [DEMO_MARKER, 'demoReady', 'demoError', 'demoApp', '?demo', "get('demo')", 'qwen3', LONG_TITLE, day2]) {
				expect(f.text.includes(marker), `${marker} in ${f.name}`).toBe(false);
			}
		}
		for (const f of files) {
			if (f.name.endsWith('.html') || f.name.endsWith('.css')) {
				expect(f.text, f.name).not.toMatch(/(?:src|href)=["']?(?:https?:)?\/\//);
				expect(f.text, f.name).not.toMatch(/url\(["']?(?:https?:)?\/\//);
			}
		}
	}, 60_000);
});
