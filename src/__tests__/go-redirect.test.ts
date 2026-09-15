import { describe, expect, it } from 'vitest';
import {
	buildRedirectTarget,
	handleAffiliateRedirect,
	indexAssignmentsById,
	indexAssignmentsBySlug,
	type Env,
} from '../index';

// Helpers ---------------------------------------------------------------

function mockAssetsWithLinks(linksJson: unknown): Env {
	return {
		ASSETS: {
			async fetch(req: Request): Promise<Response> {
				const url = new URL(req.url);
				if (url.pathname === '/links.json') {
					return new Response(JSON.stringify(linksJson), {
						headers: { 'content-type': 'application/json' },
					});
				}
				return new Response('Not Found', { status: 404 });
			},
		} as unknown as Fetcher,
	};
}

function mockAssetsMissingLinks(): Env {
	return {
		ASSETS: {
			async fetch(): Promise<Response> {
				return new Response('Not Found', { status: 404 });
			},
		} as unknown as Fetcher,
	};
}

// indexAssignmentsById --------------------------------------------------

describe('indexAssignmentsById', () => {
	it('indexes outgoing assignments keyed on assignment_id', () => {
		const map = indexAssignmentsById([
			{ assignment_id: 'asg_1', code: 'primary-cta', direction: 'outgoing', target_url: 'https://x' },
			{ assignment_id: 'asg_2', code: 'footer-banner', direction: 'outgoing', target_url: 'https://y' },
		]);
		expect(map.get('asg_1')?.code).toBe('primary-cta');
		expect(map.get('asg_2')?.code).toBe('footer-banner');
	});

	it('skips entries with missing target_url', () => {
		const map = indexAssignmentsById([
			{ assignment_id: 'asg_1', code: 'primary-cta', direction: 'outgoing' } as never,
		]);
		expect(map.size).toBe(0);
	});
});

// indexAssignmentsBySlug ------------------------------------------------

describe('indexAssignmentsBySlug', () => {
	it('indexes only assignments with a valid slug', () => {
		const map = indexAssignmentsBySlug([
			{ assignment_id: 'asg_1', code: 'cta', direction: 'outgoing', target_url: 'https://x', slug: 'play-now' },
			{ assignment_id: 'asg_2', code: 'banner', direction: 'outgoing', target_url: 'https://y' },
		]);
		expect(map.get('play-now')?.assignment_id).toBe('asg_1');
		expect(map.size).toBe(1);
	});

	it('skips malformed slugs so they cannot shadow an id', () => {
		const map = indexAssignmentsBySlug([
			{ assignment_id: 'asg_1', code: 'cta', direction: 'outgoing', target_url: 'https://x', slug: 'Bad Slug' } as never,
		]);
		expect(map.size).toBe(0);
	});
});

// buildRedirectTarget ---------------------------------------------------

describe('buildRedirectTarget', () => {
	it('returns the target unchanged when there is no incoming query', () => {
		expect(buildRedirectTarget('https://aff.example/click', '')).toBe('https://aff.example/click');
	});

	it('appends incoming UTMs when target has no query string', () => {
		expect(buildRedirectTarget('https://aff.example/click', '?utm_source=tg&utm_medium=cta'))
			.toBe('https://aff.example/click?utm_source=tg&utm_medium=cta');
	});

	it('appends incoming UTMs with & when target already has query string', () => {
		expect(buildRedirectTarget('https://aff.example/click?id=42', '?utm_source=tg'))
			.toBe('https://aff.example/click?id=42&utm_source=tg');
	});

	it('inserts the query BEFORE a fragment so the destination sees it (#39)', () => {
		// Without fragment-splitting the query lands inside the fragment
		// (…#section?utm) where the destination never receives it.
		expect(buildRedirectTarget('https://aff.example/click#section', '?utm_source=tg'))
			.toBe('https://aff.example/click?utm_source=tg#section');
		expect(buildRedirectTarget('https://aff.example/click?id=42#frag', '?utm_source=tg'))
			.toBe('https://aff.example/click?id=42&utm_source=tg#frag');
	});
});

// handleAffiliateRedirect ----------------------------------------------

describe('handleAffiliateRedirect', () => {
	it('302s to the assignment target_url on a known id', async () => {
		const env = mockAssetsWithLinks({
			schema_version: '1.0',
			assignments: [
				{ assignment_id: 'asg_1', code: 'primary-cta', direction: 'outgoing', target_url: 'https://aff.example/click?id=42' },
			],
		});
		const url = new URL('https://site.example/go/asg_1');
		const res = await handleAffiliateRedirect(new Request(url.toString()), env, url, 'asg_1');
		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toBe('https://aff.example/click?id=42');
	});

	it('forwards incoming UTMs to the target', async () => {
		const env = mockAssetsWithLinks({
			schema_version: '1.0',
			assignments: [
				{ assignment_id: 'asg_1', code: 'primary-cta', direction: 'outgoing', target_url: 'https://aff.example/click' },
			],
		});
		const url = new URL('https://site.example/go/asg_1?utm_source=tg&utm_medium=cta');
		const res = await handleAffiliateRedirect(new Request(url.toString()), env, url, 'asg_1');
		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toBe('https://aff.example/click?utm_source=tg&utm_medium=cta');
	});

	it('404s when assignment_id is unknown', async () => {
		const env = mockAssetsWithLinks({
			schema_version: '1.0',
			assignments: [
				{ assignment_id: 'asg_1', code: 'primary-cta', direction: 'outgoing', target_url: 'https://aff.example/click' },
			],
		});
		const url = new URL('https://site.example/go/asg_nope');
		const res = await handleAffiliateRedirect(new Request(url.toString()), env, url, 'asg_nope');
		expect(res.status).toBe(404);
	});

	it('404s when links.json is missing entirely (no assignments)', async () => {
		const env = mockAssetsMissingLinks();
		const url = new URL('https://site.example/go/anything');
		const res = await handleAffiliateRedirect(new Request(url.toString()), env, url, 'anything');
		expect(res.status).toBe(404);
	});

	it('back-compat: /go/<existing-id> still 302s when the assignment has a slug', async () => {
		const env = mockAssetsWithLinks({
			schema_version: '1.0',
			assignments: [
				{ assignment_id: 'asg_1', code: 'primary-cta', direction: 'outgoing', target_url: 'https://aff.example/click', slug: 'play-now' },
			],
		});
		const url = new URL('https://site.example/go/asg_1');
		const res = await handleAffiliateRedirect(new Request(url.toString()), env, url, 'asg_1');
		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toBe('https://aff.example/click');
	});

	it('/go/<slug> 302s to the same target as the id', async () => {
		const env = mockAssetsWithLinks({
			schema_version: '1.0',
			assignments: [
				{ assignment_id: 'asg_1', code: 'primary-cta', direction: 'outgoing', target_url: 'https://aff.example/click', slug: 'play-now' },
			],
		});
		const url = new URL('https://site.example/go/play-now');
		const res = await handleAffiliateRedirect(new Request(url.toString()), env, url, 'play-now');
		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toBe('https://aff.example/click');
	});

	it('slug resolves first when a slug shadows another assignment_id token (shadow case)', async () => {
		// A slug is [a-z0-9-] (no underscore); an assignment_id is typically
		// asn_*/UUID (underscore), so a real collision is near-zero. But the
		// id field is free-form, so we use a hyphen-only id token to exercise
		// the slug-first precedence deterministically.
		const env = mockAssetsWithLinks({
			schema_version: '1.0',
			assignments: [
				// This entry's *id* equals the next entry's *slug*.
				{ assignment_id: 'go-deal', code: 'b', direction: 'outgoing', target_url: 'https://id-target.example' },
				{ assignment_id: 'asg_target', code: 'a', direction: 'outgoing', target_url: 'https://slug-target.example', slug: 'go-deal' },
			],
		});
		const url = new URL('https://site.example/go/go-deal');
		const res = await handleAffiliateRedirect(new Request(url.toString()), env, url, 'go-deal');
		expect(res.status).toBe(302);
		// slug-first → the slug owner wins, not the id collision.
		expect(res.headers.get('location')).toBe('https://slug-target.example');
	});

	it('/go/<regional-lang>/<brand> (en-au/starzinocas) 302s — ll-rr slugs resolve', async () => {
		const env = mockAssetsWithLinks({
			schema_version: '1.0',
			assignments: [
				{ assignment_id: 'asg_au', code: 'starzinocas-en-au', direction: 'outgoing', target_url: 'https://aff.example/au', slug: 'en-au/starzinocas' },
				{ assignment_id: 'asg_en', code: 'starzinocas-en', direction: 'outgoing', target_url: 'https://aff.example/en', slug: 'en/starzinocas' },
			],
		});
		const url = new URL('https://site.example/go/en-au/starzinocas');
		const res = await handleAffiliateRedirect(new Request(url.toString()), env, url, 'en-au/starzinocas');
		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toBe('https://aff.example/au');
		// The plain-en shared link stays independently routable (back-compat).
		const enUrl = new URL('https://site.example/go/en/starzinocas');
		const enRes = await handleAffiliateRedirect(new Request(enUrl.toString()), env, enUrl, 'en/starzinocas');
		expect(enRes.headers.get('location')).toBe('https://aff.example/en');
	});

	it('unknown token (neither slug nor id) → 404', async () => {
		const env = mockAssetsWithLinks({
			schema_version: '1.0',
			assignments: [
				{ assignment_id: 'asg_1', code: 'primary-cta', direction: 'outgoing', target_url: 'https://aff.example/click', slug: 'play-now' },
			],
		});
		const url = new URL('https://site.example/go/nope');
		const res = await handleAffiliateRedirect(new Request(url.toString()), env, url, 'nope');
		expect(res.status).toBe(404);
	});

	it('sets Cache-Control: no-store on the redirect', async () => {
		const env = mockAssetsWithLinks({
			schema_version: '1.0',
			assignments: [
				{ assignment_id: 'asg_1', code: 'primary-cta', direction: 'outgoing', target_url: 'https://aff.example/click' },
			],
		});
		const url = new URL('https://site.example/go/asg_1');
		const res = await handleAffiliateRedirect(new Request(url.toString()), env, url, 'asg_1');
		expect(res.headers.get('cache-control')).toBe('no-store');
	});
});
