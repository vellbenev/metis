import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import type { JSONNode } from '../core/blocks';
import type { TextbookReport } from '../textbook/build';
import type { Textbook, TextbookOutline } from '../vault/types';

const has = (node: JSONNode, type: string) => node.marks?.find(m => m.type === type);

function renderText(node: JSONNode, key: number): ReactNode {
	let out: ReactNode = node.text;
	if (has(node, 'gap')) out = <span className='gap'>{out}</span>;
	const ai = has(node, 'aiAdded');
	if (ai && ai.attrs?.accepted !== true) out = <span className='ai-added'>{out}</span>;
	return <Fragment key={key}>{out}</Fragment>;
}

function renderNode(node: JSONNode, key: number): ReactNode {
	const kids = () => (node.content ?? []).map((c, i) => (typeof c.text === 'string' ? renderText(c, i) : renderNode(c, i)));
	switch (node.type) {
		case 'paragraph':
			return <p key={key}>{kids()}</p>;
		case 'heading':
			return <h3 key={key}>{kids()}</h3>;
		case 'bulletList':
			return <ul key={key}>{kids()}</ul>;
		case 'orderedList':
			return <ol key={key}>{kids()}</ol>;
		case 'listItem':
			return <li key={key}>{kids()}</li>;
		case 'blockquote':
			return <blockquote key={key}>{kids()}</blockquote>;
		case 'codeBlock':
			return (
				<pre key={key} dir='ltr'>
					<code>{kids()}</code>
				</pre>
			);
		case 'hardBreak':
			return <br key={key} />;
		default:
			return <Fragment key={key}>{kids()}</Fragment>;
	}
}

/** Sections the last build changed, to highlight. */
function changedIds(report?: TextbookReport): Set<string> {
	if (!report) return new Set();
	const o = report.outline;
	return new Set([...o.added, ...o.renamed, ...o.assigned, ...o.merged.map(m => m.into), ...report.regenerated]);
}

export interface TextbookViewProps {
	load(): Promise<{ outline?: TextbookOutline; textbook?: Textbook }>;
	report?: TextbookReport;
	/** Changes when the textbook on disk may have changed. */
	version?: unknown;
}

/** Read-only textbook: sections in outline order, what the last build changed highlighted, then the gaps. */
export function TextbookView({ load, report, version }: TextbookViewProps) {
	const [data, setData] = useState<{ outline?: TextbookOutline; textbook?: Textbook }>();
	const loadRef = useRef(load);
	loadRef.current = load;
	useEffect(() => {
		void loadRef.current().then(setData);
	}, [version]);

	if (!data) return null;
	const sections = [...(data.outline?.sections ?? [])].sort((a, b) => a.order - b.order);
	if (sections.length === 0) return <p className='textbook-empty'>هنوز جزوه‌ای ساخته نشده است.</p>;
	const changed = changedIds(report);
	const gaps = data.textbook?.gaps ?? [];
	const title = (id: string) => sections.find(s => s.id === id)?.title ?? '';

	return (
		<article className='textbook' dir='rtl'>
			{sections.map(s => (
				<section key={s.id} data-section={s.id} className={changed.has(s.id) ? 'textbook-section changed' : 'textbook-section'}>
					<h2>{s.title}</h2>
					{(data.textbook?.sections[s.id]?.doc.content ?? []).map(renderNode)}
				</section>
			))}
			{gaps.length > 0 && (
				<section className='textbook-gaps'>
					<h2>جاهای خالی</h2>
					<ul>
						{gaps.map((g, i) => (
							<li key={i}>
								<span className='gap-section'>{title(g.sectionId)}:</span> {g.note}
							</li>
						))}
					</ul>
				</section>
			)}
		</article>
	);
}
