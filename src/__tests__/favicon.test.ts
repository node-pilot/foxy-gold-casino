import { describe, expect, it, vi } from 'vitest';
import { handleFaviconIco, type Env } from '../index';

function mockEnv(files: Record<string, string>): Env {
	return {
		ASSETS: {
			fetch: vi.fn(async (req: Request) => {
				const path = new URL(req.url).pathname;
				const body = files[path];
				if (body === undefined) {
					return new Response('Not Found', { status: 404 });
				}
				return new Response(body, {
					status: 200,
					headers: { 'Content-Type': 'image/svg+xml' },
				});
			}),
		} as unknown as Fetcher,
	};
}

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><text>C</text></svg>';

describe('handleFaviconIco — /favicon.ico served from favicon.svg', () => {
	it('serves favicon.svg bytes as image/svg+xml with a 200', async () => {
		const env = mockEnv({ '/favicon.svg': SVG });
		const res = await handleFaviconIco(env, 'example.com');
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('image/svg+xml');
		expect(await res.text()).toBe(SVG);
	});

	it('fetches /favicon.svg (not /favicon.ico) from ASSETS', async () => {
		const env = mockEnv({ '/favicon.svg': SVG });
		await handleFaviconIco(env, 'example.com');
		const fetchMock = env.ASSETS.fetch as unknown as ReturnType<typeof vi.fn>;
		const requestedPath = new URL(fetchMock.mock.calls[0][0].url).pathname;
		expect(requestedPath).toBe('/favicon.svg');
	});

	it('404s when favicon.svg is absent (nothing to serve, no binary fallback)', async () => {
		const env = mockEnv({});
		const res = await handleFaviconIco(env, 'example.com');
		expect(res.status).toBe(404);
	});
});
