import { describe, expect, it } from 'vitest';
import worker, { type Env } from '../index';
import { V3_RUNTIME_VERSION } from '../version.gen';

function mockEnv(files: Record<string, string>): Env {
	return {
		ASSETS: {
			async fetch(req: Request): Promise<Response> {
				let path = new URL(req.url).pathname;
				// Cloudflare ASSETS resolves `/` to `/index.html` — mirror that.
				if (path === '/') path = '/index.html';
				const body = files[path];
				if (body === undefined) {
					return new Response('Not Found', { status: 404 });
				}
				return new Response(body, {
					status: 200,
					headers: { 'Content-Type': 'text/html; charset=utf-8' },
				});
			},
		} as unknown as Fetcher,
	};
}

function basicAuth(user: string, pass: string): string {
	return 'Basic ' + btoa(`${user}:${pass}`);
}

describe('preview basic-auth gate', () => {
	const env = mockEnv({ '/index.html': '<html><body>ok</body></html>' });

	it('challenges with 401 when no credentials on .workers.dev', async () => {
		const res = await worker.fetch(new Request('https://saga.xndr.workers.dev/'), env);
		expect(res.status).toBe(401);
		expect(res.headers.get('WWW-Authenticate')).toContain('Basic');
		expect(res.headers.get('X-Robots-Tag')).toContain('noindex');
	});

	it('rejects wrong credentials with 401', async () => {
		const res = await worker.fetch(
			new Request('https://saga.xndr.workers.dev/', {
				headers: { Authorization: basicAuth('levr', 'wrong') },
			}),
			env
		);
		expect(res.status).toBe(401);
	});

	it('accepts levr:preview123 and sets _lp session cookie', async () => {
		const res = await worker.fetch(
			new Request('https://saga.xndr.workers.dev/', {
				headers: { Authorization: basicAuth('levr', 'preview123') },
			}),
			env
		);
		expect(res.status).toBe(200);
		expect(res.headers.get('Set-Cookie')).toContain('_lp=1');
		expect(res.headers.get('X-Robots-Tag')).toContain('noindex');
	});

	it('bypasses auth when _lp=1 cookie is present', async () => {
		const res = await worker.fetch(
			new Request('https://saga.xndr.workers.dev/', {
				headers: { Cookie: '_lp=1' },
			}),
			env
		);
		expect(res.status).toBe(200);
		// Cookie path — no need to re-set
		expect(res.headers.get('Set-Cookie')).toBeNull();
		// Still tagged noindex (it's a preview)
		expect(res.headers.get('X-Robots-Tag')).toContain('noindex');
	});

	it('custom domain bypasses auth entirely', async () => {
		const res = await worker.fetch(new Request('https://saga-spin.com/'), env);
		expect(res.status).toBe(200);
		expect(res.headers.get('Set-Cookie')).toBeNull();
		expect(res.headers.get('X-Robots-Tag')).toBeNull();
	});

	it('gates non-HTML assets on workers.dev too', async () => {
		const e = mockEnv({}); // /robots.txt 404 → falls through to /404.html
		const res = await worker.fetch(new Request('https://saga.xndr.workers.dev/robots.txt'), e);
		expect(res.status).toBe(401);
	});

	it('gates /go/:id redirect on workers.dev too', async () => {
		const res = await worker.fetch(new Request('https://saga.xndr.workers.dev/go/asg_1'), env);
		expect(res.status).toBe(401);
	});

	it('serves /api/health unauthenticated on workers.dev (not 401)', async () => {
		const res = await worker.fetch(
			new Request('https://saga.xndr.workers.dev/api/health'),
			env
		);
		expect(res.status).toBe(200);
		expect(res.headers.get('WWW-Authenticate')).toBeNull();
		const body = (await res.json()) as { status: string; version: string; runtime: string };
		expect(body.status).toBe('ok');
		expect(body.version).toBe(V3_RUNTIME_VERSION);
		expect(body.runtime).toBe('agentic_v3');
	});
});

describe('/api/analytics pageview beacon', () => {
	it('POST writes one PAGEVIEWS datapoint and returns 204 (no auth)', async () => {
		const calls: Array<{ blobs?: (string | ArrayBuffer)[]; indexes?: string[]; doubles?: number[] }> = [];
		const env = {
			...mockEnv({ '/index.html': '<html></html>' }),
			PAGEVIEWS: { writeDataPoint: (p: any) => calls.push(p) } as unknown as AnalyticsEngineDataset,
		} as Env;
		const res = await worker.fetch(
			new Request('https://saga.xndr.workers.dev/api/analytics', {
				method: 'POST',
				body: JSON.stringify({ page: '/promo' }),
			}),
			env
		);
		expect(res.status).toBe(204);
		expect(calls.length).toBe(1);
		expect(calls[0].blobs?.[0]).toBe('pageview');
		expect(calls[0].blobs?.[2]).toBe('saga.xndr.workers.dev');
	});

	it('GET /api/analytics is not 204 (falls through to assets)', async () => {
		const env = mockEnv({ '/api/analytics': '<html>page</html>' });
		const res = await worker.fetch(
			new Request('https://saga-spin.com/api/analytics'),
			env
		);
		expect(res.status).not.toBe(204);
	});
});
