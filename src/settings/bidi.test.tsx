import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ollamaOriginsHint } from '../provider/errors';
import { Bidi, splitLatinRuns } from './bidi';

const ltrRuns = (text: string) => splitLatinRuns(text).filter(s => s.ltr).map(s => s.text);

describe('splitLatinRuns', () => {
	it('returns the text unchanged when joined', () => {
		for (const text of ['', 'فقط فارسی', 'prover', ollamaOriginsHint('http://localhost:5173'), 'آدرس یا model پیدا نشد (Not Found)']) {
			expect(splitLatinRuns(text).map(s => s.text).join('')).toBe(text);
		}
	});

	it('marks Latin words, URLs and assignments as single ltr runs', () => {
		expect(ltrRuns('اصطلاحات Latin حفظ شد: بله')).toEqual(['Latin']);
		expect(ltrRuns('آدرس یا model پیدا نشد (Not Found)')).toEqual(['model', 'Not Found']);
		expect(ltrRuns('اتصال به http://localhost:11434/v1 برقرار نشد')).toEqual(['http://localhost:11434/v1']);
		expect(ltrRuns(ollamaOriginsHint('http://localhost:5173'))).toEqual(['Ollama', 'OLLAMA_ORIGINS', 'origin', 'OLLAMA_ORIGINS=http://localhost:5173']);
	});

	it('leaves Persian text, Persian digits and Persian punctuation outside the runs', () => {
		expect(splitLatinRuns('زمان ۱۲ ثانیه، prover؟')).toEqual([
			{ text: 'زمان ۱۲ ثانیه، ', ltr: false },
			{ text: 'prover', ltr: true },
			{ text: '؟', ltr: false },
		]);
	});
});

describe('Bidi', () => {
	it('wraps each Latin run in <bdi dir="ltr">', () => {
		expect(renderToStaticMarkup(<Bidi text='خطای سرور (500) در x/y' />)).toBe(
			'خطای سرور (<bdi dir="ltr">500</bdi>) در <bdi dir="ltr">x/y</bdi>',
		);
	});
});
