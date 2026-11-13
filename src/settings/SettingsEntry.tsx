import { useState } from 'react';
import { SettingsScreen } from './SettingsScreen';
import { createIdbSettingsStore, type SettingsStore } from './store';
import './settings.css';

let defaultStore: SettingsStore | undefined;

/** The app's settings store (IndexedDB), shared by the settings screen and the Clean button. */
export function appSettingsStore(): SettingsStore {
	return (defaultStore ??= createIdbSettingsStore());
}

/** The app shell's entry point to the provider settings. */
export function SettingsEntry({ store }: { store?: SettingsStore }) {
	const [open, setOpen] = useState(false);
	return (
		<div className='settings-entry'>
			<button type='button' name='settings' aria-expanded={open} onClick={() => setOpen(o => !o)}>
				تنظیمات
			</button>
			{open && <SettingsScreen store={store ?? appSettingsStore()} />}
		</div>
	);
}
