// Binds the editor to one raw note at a time: loads it, and saves edits back after a short pause.
// This is the editor side of I1: the only caller of VaultStore.saveNote.

import type { Editor } from '@tiptap/core';
import type { JSONNode } from '../core/blocks';
import type { VaultPath, VaultStore } from '../vault/store';
import type { RawNote } from '../vault/types';

interface Open {
	store: VaultStore;
	path: VaultPath;
	note: RawNote;
	dirty: boolean;
}

const startsWith = (path: VaultPath, prefix: VaultPath) =>
	prefix.length <= path.length && prefix.every((name, i) => path[i] === name);

export class NoteSession {
	private current: Open | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private saving: Promise<void> = Promise.resolve();

	constructor(
		private editor: Editor,
		private delay = 600,
	) {
		editor.on('update', this.onUpdate);
	}

	get path(): VaultPath | undefined {
		return this.current?.path;
	}

	private onUpdate = () => {
		if (!this.current) return;
		this.current.dirty = true;
		clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.flush(), this.delay);
	};

	async open(store: VaultStore, path: VaultPath): Promise<void> {
		await this.flush();
		const note = await store.loadNote(path);
		this.current = undefined; // ignore updates caused by loading
		this.editor.commands.setContent(note.doc, { emitUpdate: false });
		this.current = { store, path, note, dirty: false };
	}

	/** Writes pending edits now. */
	flush(): Promise<void> {
		clearTimeout(this.timer);
		this.saving = this.saving.then(async () => {
			const open = this.current;
			if (!open?.dirty) return;
			open.dirty = false;
			const note: RawNote = { ...open.note, doc: this.editor.getJSON() as JSONNode };
			await open.store.saveNote(open.path, note);
			open.note = note;
		});
		return this.saving;
	}

	/** Call after a folder or note was renamed, so the open note keeps saving to the right file. */
	async moved(from: VaultPath, to: VaultPath): Promise<void> {
		const open = this.current;
		if (!open || !startsWith(open.path, from)) return;
		open.path = [...to, ...open.path.slice(from.length)];
		open.note = { ...open.note, title: (await open.store.loadNote(open.path)).title };
	}

	async close(): Promise<void> {
		await this.flush();
		this.current = undefined;
	}

	destroy(): void {
		void this.flush();
		this.editor.off('update', this.onUpdate);
	}
}
