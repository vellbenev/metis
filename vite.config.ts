import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [react()],
	build: {
		// The preload polyfill uses fetch(); the app makes no requests besides the model baseUrl (I6).
		modulePreload: { polyfill: false },
	},
	test: {
		include: ['src/**/*.test.{ts,tsx}'],
	},
});
