import { join } from 'node:path';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';

// I6: the built app makes no network requests of its own and loads nothing remote.
describe('production build (I6)', () => {
	it('contains one fetch( call (the provider client) and no remote URL references', async () => {
		const result = await build({
			root: join(import.meta.dirname, '..'),
			logLevel: 'silent',
			build: { write: false, chunkSizeWarningLimit: Infinity },
		});
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
		for (const f of files) {
			if (f.name.endsWith('.html') || f.name.endsWith('.css')) {
				expect(f.text, f.name).not.toMatch(/(?:src|href)=["']?(?:https?:)?\/\//);
				expect(f.text, f.name).not.toMatch(/url\(["']?(?:https?:)?\/\//);
			}
		}
	}, 60_000);
});
