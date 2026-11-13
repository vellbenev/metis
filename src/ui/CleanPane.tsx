import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CleanDerivedStore } from '../clean/ports';
import {
	collectGaps,
	highlightKey,
	linkedBlocks,
	linkMap,
	segments,
	visibleHighlights,
	type BlockRef,
} from '../cleanView/model';
import type { BlockId, JSONNode } from '../core/blocks';
import { acceptAi, loadCleanView, removeAi, undoLastClean, type CleanViewState } from './cleanView';

const has = (node: JSONNode, type: string) => node.marks?.some(m => m.type === type) ?? false;
const accepted = (node: JSONNode) => node.marks?.find(m => m.type === 'aiAdded')?.attrs?.accepted === true;

function renderText(node: JSONNode, key: number): ReactNode {
	let out: ReactNode = node.text;
	if (has(node, 'code')) out = <code>{out}</code>;
	if (has(node, 'italic')) out = <em>{out}</em>;
	if (has(node, 'bold')) out = <strong>{out}</strong>;
	if (has(node, 'gap')) out = <span className='gap'>{out}</span>;
	return <Fragment key={key}>{out}</Fragment>;
}

interface Ctx {
	ai: number;
	onAccept(index: number): void;
	onRemove(index: number): void;
}

/** Inline content; `aiAdded` runs are counted in the same order as `runsIn` in the model. */
function renderContent(content: JSONNode[] | undefined, ctx: Ctx): ReactNode[] {
	return segments(content, 'aiAdded').map((s, i) => {
		if ('node' in s) return typeof s.node.text === 'string' ? renderText(s.node, i) : renderNode(s.node, i, ctx);
		const index = ctx.ai++;
		const text = s.run.map(renderText);
		if (s.run.every(accepted)) return <Fragment key={i}>{text}</Fragment>;
		// I4: unaccepted aiAdded text is visually distinct.
		return (
			<span key={i} className='ai-added' data-ai-index={index}>
				{text}
				<span className='ai-actions' onClick={e => e.stopPropagation()}>
					<button
						type='button'
						name='ai-accept'
						title='پذیرفتن'
						aria-label='پذیرفتن'
						onClick={() => ctx.onAccept(index)}
					>
						✓
					</button>
					<button
						type='button'
						name='ai-remove'
						title='حذف'
						aria-label='حذف'
						onClick={() => ctx.onRemove(index)}
					>
						✕
					</button>
				</span>
			</span>
		);
	});
}

function renderNode(node: JSONNode, key: number, ctx: Ctx, top?: Record<string, unknown>): ReactNode {
	const kids = () => renderContent(node.content, ctx);
	const p = top ?? {};
	switch (node.type) {
		case 'paragraph':
			return (
				<p key={key} {...p}>
					{kids()}
				</p>
			);
		case 'heading': {
			const level = Number(node.attrs?.level ?? 2);
			return level === 1 ? (
				<h1 key={key} {...p}>
					{kids()}
				</h1>
			) : level === 2 ? (
				<h2 key={key} {...p}>
					{kids()}
				</h2>
			) : (
				<h3 key={key} {...p}>
					{kids()}
				</h3>
			);
		}
		case 'bulletList':
			return (
				<ul key={key} {...p}>
					{kids()}
				</ul>
			);
		case 'orderedList':
			return (
				<ol key={key} {...p}>
					{kids()}
				</ol>
			);
		case 'listItem':
			return (
				<li key={key} {...p}>
					{kids()}
				</li>
			);
		case 'blockquote':
			return (
				<blockquote key={key} {...p}>
					{kids()}
				</blockquote>
			);
		case 'codeBlock':
			return (
				<pre key={key} {...p} dir='ltr'>
					<code>{kids()}</code>
				</pre>
			);
		case 'horizontalRule':
			return <hr key={key} {...p} />;
		case 'hardBreak':
			return <br key={key} />;
		default:
			return (
				<div key={key} {...p}>
					{kids()}
				</div>
			);
	}
}

export interface CleanPaneProps {
	derived: CleanDerivedStore;
	fileId: string;
	/** Changes when the clean twin on disk may have changed (e.g. after Clean). */
	version?: unknown;
	selected?: BlockRef;
	onSelect(ref: BlockRef): void;
	/** Raw blocks linked to the selection; `scroll` when the selection is on the clean side. */
	onLinkedRaw?(ids: BlockId[], scroll: boolean): void;
	/** Called after the pane changed derived data (undo, accept, remove). */
	onChanged?(): void;
}

/**
 * The clean twin beside the raw note: blocks linked by `sources`, the last clean's changes
 * highlighted until dismissed (UI state only), one-click accept/remove of `aiAdded` spans, undo of
 * the last clean, and the list of `gap` spans. It never asks or blocks anything.
 */
export function CleanPane({ derived, fileId, version, selected, onSelect, onLinkedRaw, onChanged }: CleanPaneProps) {
	const [view, setView] = useState<CleanViewState>();
	const [reload, setReload] = useState(0);
	const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
	const [error, setError] = useState<string>();
	const pane = useRef<HTMLDivElement>(null);

	useEffect(() => {
		let live = true;
		loadCleanView(derived, fileId).then(
			v => live && setView(v),
			e => live && setError(String(e?.message ?? e)),
		);
		return () => {
			live = false;
		};
	}, [derived, fileId, version, reload]);

	const clean = view?.clean?.fileId === fileId ? view.clean : undefined;
	const map = useMemo(() => linkMap(clean), [clean]);
	const linked = useMemo(() => linkedBlocks(map, selected), [map, selected]);
	const highlighted = useMemo(() => new Set(visibleHighlights(clean, dismissed)), [clean, dismissed]);
	const gaps = useMemo(() => collectGaps(clean), [clean]);

	const linkedRawKey = linked.raw.join(' ');
	const onLinkedRef = useRef(onLinkedRaw);
	onLinkedRef.current = onLinkedRaw;
	useEffect(() => {
		onLinkedRef.current?.(linked.raw, selected?.side === 'clean');
		if (selected?.side === 'raw' && linked.clean[0]) {
			pane.current
				?.querySelector(`[data-clean-id="${CSS.escape(linked.clean[0])}"]`)
				?.scrollIntoView?.({ block: 'nearest' });
		}
	}, [linkedRawKey, selected]);

	async function act(run: () => Promise<unknown>) {
		setError(undefined);
		try {
			await run();
			onChanged?.();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
		setReload(n => n + 1);
	}

	if (!clean) {
		return (
			<aside className='clean-pane' dir='rtl'>
				{view && <p className='clean-empty'>هنوز پاک‌نویسی ساخته نشده است.</p>}
			</aside>
		);
	}

	const linkedClean = new Set(linked.clean);
	return (
		<aside className='clean-pane' dir='rtl' ref={pane}>
			<div className='clean-tools'>
				<button
					type='button'
					name='undo-clean'
					disabled={!view?.canUndo}
					onClick={() => act(() => undoLastClean(derived, fileId))}
				>
					برگرداندن پاک‌نویس قبلی
				</button>
				{highlighted.size > 0 && (
					<button
						type='button'
						name='dismiss-highlights'
						onClick={() => setDismissed(d => new Set([...d, highlightKey(clean)]))}
					>
						برداشتن نشانه‌ی تغییرها
					</button>
				)}
			</div>
			{error && (
				<p className='clean-status' role='status'>
					{error}
				</p>
			)}
			<article className='clean-doc'>
				{(clean.doc.content ?? []).map((block, i) => {
					const id = block.attrs?.id as BlockId;
					const classes = ['clean-block', highlighted.has(id) && 'changed', linkedClean.has(id) && 'linked'];
					const ctx: Ctx = {
						ai: 0,
						onAccept: index => act(() => acceptAi(derived, fileId, id, index)),
						onRemove: index => act(() => removeAi(derived, fileId, id, index)),
					};
					return renderNode(block, i, ctx, {
						'data-clean-id': id,
						className: classes.filter(Boolean).join(' '),
						onClick: () => onSelect({ side: 'clean', id }),
					});
				})}
			</article>
			{gaps.length > 0 && (
				<section className='clean-gaps'>
					<h2>جاهای نامشخص</h2>
					<ul>
						{gaps.map(g => (
							<li key={`${g.blockId}:${g.index}`}>
								<button type='button' onClick={() => onSelect({ side: 'clean', id: g.blockId })}>
									{g.text}
								</button>
							</li>
						))}
					</ul>
				</section>
			)}
		</aside>
	);
}
