import { describe, expect, it } from 'vitest';
import worker, { classifyDevice, refererHost, type Env } from '../index';

type Datapoint = { blobs?: (string | ArrayBuffer)[]; indexes?: string[]; doubles?: number[] };

/**
 * Build a Request and attach `cf` (Cloudflare request metadata) the way the
 * Workers runtime exposes it. The undici Request used in vitest drops unknown
 * `init` keys, so `cf` must be assigned onto the instance after construction.
 */
function reqWithCf(url: string, init: RequestInit, cf?: { country?: string }): Request {
	const req = new Request(url, init);
	if (cf) (req as unknown as { cf: typeof cf }).cf = cf;
	return req;
}

/**
 * Asset mock that serves HTML for known paths (and `/` → `/index.html`, like
 * Cloudflare ASSETS), a non-HTML asset for `/styles.css`, and 404 otherwise.
 * Captures every PAGEVIEWS datapoint so we can assert the server-side emit.
 */
function mockEnv(files: Record<string, string>, calls: Datapoint[]): Env {
	return {
		ASSETS: {
			async fetch(req: Request): Promise<Response> {
				let path = new URL(req.url).pathname;
				if (path === '/') path = '/index.html';
				if (path === '/styles.css') {
					return new Response('body{}', {
						status: 200,
						headers: { 'Content-Type': 'text/css' },
					});
				}
				const body = files[path];
				// Cloudflare ASSETS serves missing routes as an HTML 404 (so the
				// worker's 404 HTML branch runs, not the non-HTML pass-through).
				if (body === undefined) {
					return new Response('Not Found', {
						status: 404,
						headers: { 'Content-Type': 'text/html; charset=utf-8' },
					});
				}
				return new Response(body, {
					status: 200,
					headers: { 'Content-Type': 'text/html; charset=utf-8' },
				});
			},
		} as unknown as Fetcher,
		PAGEVIEWS: { writeDataPoint: (p: Datapoint) => calls.push(p) } as unknown as AnalyticsEngineDataset,
	} as Env;
}

describe('classifyDevice', () => {
	it('detects bots', () => {
		expect(classifyDevice('Googlebot/2.1 (+http://www.google.com/bot.html)')).toBe('bot');
		expect(classifyDevice('curl/8.4.0')).toBe('bot');
		expect(classifyDevice('python-requests/2.31')).toBe('bot');
	});
	it('detects mobile', () => {
		expect(classifyDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile/15E148')).toBe('mobile');
		expect(classifyDevice('Mozilla/5.0 (Linux; Android 14) Mobile')).toBe('mobile');
	});
	it('defaults to desktop', () => {
		expect(classifyDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('desktop');
		expect(classifyDevice('')).toBe('desktop');
	});
});

describe('refererHost (privacy: host only, no path/query)', () => {
	it('strips path and query, keeps host only', () => {
		expect(refererHost('https://google.com/search?q=secret+pii')).toBe('google.com');
		expect(refererHost('https://news.ycombinator.com/item?id=42')).toBe('news.ycombinator.com');
	});
	it('returns empty string for missing/invalid referer', () => {
		expect(refererHost(null)).toBe('');
		expect(refererHost('not a url')).toBe('');
	});
});

describe('server-side pageview emit', () => {
	it('emits exactly one datapoint per HTML response with correct blob/index/double order', async () => {
		const calls: Datapoint[] = [];
		const env = mockEnv({ '/index.html': '<html><body>home</body></html>' }, calls);
		const res = await worker.fetch(
			reqWithCf(
				'https://saga-spin.com/',
				{
					headers: {
						'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
						Referer: 'https://google.com/search?q=casino',
					},
				},
				{ country: 'AD' }
			),
			env
		);
		expect(res.status).toBe(200);
		expect(calls.length).toBe(1);
		// blob2 = the REQUEST pathname ('/'), not the resolved asset file.
		// Schema mirrors levr_aff_clicks: blob order, index1 = host, double1 = 1.
		expect(calls[0].blobs).toEqual(['saga-spin.com', '/', 'google.com', 'AD', 'desktop']);
		expect(calls[0].indexes).toEqual(['saga-spin.com']);
		expect(calls[0].doubles).toEqual([1]);
	});

	it('emits one datapoint on the 404 HTML branch', async () => {
		const calls: Datapoint[] = [];
		const env = mockEnv({ '/404.html': '<html><body>missing</body></html>' }, calls);
		const res = await worker.fetch(
			new Request('https://saga-spin.com/nope', {
				headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0)' },
			}),
			env
		);
		expect(res.status).toBe(404);
		expect(calls.length).toBe(1);
		expect(calls[0].blobs?.[0]).toBe('saga-spin.com');
		expect(calls[0].blobs?.[1]).toBe('/nope');
	});

	it('emits ZERO datapoints for a non-HTML asset response', async () => {
		const calls: Datapoint[] = [];
		const env = mockEnv({ '/index.html': '<html></html>' }, calls);
		const res = await worker.fetch(
			new Request('https://saga-spin.com/styles.css', {
				headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0)' },
			}),
			env
		);
		expect(res.status).toBe(200);
		expect(calls.length).toBe(0);
	});

	it('skips emit for a bot User-Agent (volume control)', async () => {
		const calls: Datapoint[] = [];
		const env = mockEnv({ '/index.html': '<html></html>' }, calls);
		const res = await worker.fetch(
			new Request('https://saga-spin.com/', {
				headers: { 'User-Agent': 'Googlebot/2.1 (+http://www.google.com/bot.html)' },
			}),
			env
		);
		expect(res.status).toBe(200);
		expect(calls.length).toBe(0);
	});

	it('records empty referer/country when headers absent (privacy default)', async () => {
		const calls: Datapoint[] = [];
		const env = mockEnv({ '/index.html': '<html></html>' }, calls);
		await worker.fetch(
			new Request('https://saga-spin.com/', {
				headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0)' },
			}),
			env
		);
		expect(calls.length).toBe(1);
		expect(calls[0].blobs?.[2]).toBe(''); // refHost
		expect(calls[0].blobs?.[3]).toBe(''); // country
	});
});
