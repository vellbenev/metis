import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/vazirmatn/400.css';
import '@fontsource/vazirmatn/700.css';
import './styles.css';
import { App } from './App';

const render = (app: ReactNode) =>
	createRoot(document.getElementById('root')!).render(<StrictMode>{app}</StrictMode>);

const demo = import.meta.env.DEV && new URLSearchParams(location.search).get('demo');
// The demo module is dev-only; this branch is removed from the production build (src/build.test.ts).
if (import.meta.env.DEV && demo) {
	void import('./demo/demo').then(async ({ demoApp }) => {
		const { app, drive } = await demoApp(demo);
		render(app);
		await drive();
	}).catch(e => (document.documentElement.dataset.demoError = String(e)));
} else {
	render(<App />);
}
