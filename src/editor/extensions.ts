import type { Extensions } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { BlockIds, type BlockIdsOptions } from './blockIds';
import { LinkHighlight } from './linkHighlight';

export function editorExtensions(blockIds: Partial<BlockIdsOptions> = {}): Extensions {
	return [StarterKit, BlockIds.configure(blockIds), LinkHighlight];
}
