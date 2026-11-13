import { join } from 'node:path';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';

// I6: the built app makes no network requests of its own and loads nothing remote.
describe('production build (I6)', () => {
	it('contains no fetch( call and no remote URL references', async () => {
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
		for (const f of files) {
			expect(f.text, f.name).not.toMatch(/\bfetch\s*\(/);
			if (f.name.endsWith('.html') || f.name.endsWith('.css')) {
				expect(f.text, f.name).not.toMatch(/(?:src|href)=["']?(?:https?:)?\/\//);
				expect(f.text, f.name).not.toMatch(/url\(["']?(?:https?:)?\/\//);
			}
		}
	}, 60_000);
});
