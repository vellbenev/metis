import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockProvider } from './mock';

const req = (content: string) => ({ messages: [{ role: 'user' as const, content }] });

describe('mock provider', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('counts calls and records requests in order', async () => {
		const mock = createMockProvider('[]');
		expect(mock.callCount).toBe(0);
		await mock.complete(req('a'));
		await mock.complete(req('b'));
		expect(mock.callCount).toBe(2);
		expect(mock.calls.map(c => c.messages[0].content)).toEqual(['a', 'b']);
		mock.reset();
		expect(mock.callCount).toBe(0);
	});

	it('replies with a function of the request and call index', async () => {
		const mock = createMockProvider((r, i) => `${i}:${r.messages[0].content}`);
		expect((await mock.complete(req('x'))).content).toBe('0:x');
		expect((await mock.complete(req('y'))).content).toBe('1:y');
	});

	it('a throwing reply rejects but still counts the call', async () => {
		const mock = createMockProvider(() => {
			throw new Error('down');
		});
		await expect(mock.complete(req('x'))).rejects.toThrow('down');
		expect(mock.callCount).toBe(1);
	});

	it('never touches the network', async () => {
		const fetch = vi.fn();
		vi.stubGlobal('fetch', fetch);
		await createMockProvider().complete(req('x'));
		expect(fetch).not.toHaveBeenCalled();
	});
});
