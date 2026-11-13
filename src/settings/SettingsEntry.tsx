import { useState } from 'react';
import { SettingsScreen } from './SettingsScreen';
import { createIdbSettingsStore, type SettingsStore } from './store';
import './settings.css';

let defaultStore: SettingsStore | undefined;

/** The app shell's entry point to the provider settings. */
export function SettingsEntry({ store }: { store?: SettingsStore }) {
	const [open, setOpen] = useState(false);
	return (
		<div className='settings-entry'>
			<button type='button' name='settings' aria-expanded={open} onClick={() => setOpen(o => !o)}>
				تنظیمات
			</button>
			{open && <SettingsScreen store={store ?? (defaultStore ??= createIdbSettingsStore())} />}
		</div>
	);
}
