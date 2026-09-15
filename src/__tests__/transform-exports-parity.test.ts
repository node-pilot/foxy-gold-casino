import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, {
	SECURITY_HEADERS,
	buildRedirectTarget,
	cacheHeadersFor,
	parseGoAssignments,
	parseLinksJson,
	processAffLinks,
	processCfBeacon,
	processCssInject,
	processIncludes,
	processYearToken,
	resolveGoAssignment,
	resolveSharedAffToken,
	type Env,
	type PartialLoader,
} from '../index';

/**
 * Portable-transform parity (BigCloudy plan Phase 0).
 *
 * The Worker's `fetch` handler is the OLD path and stays untouched. Phase 1
 * (`@levr/site-runtime`) will instead COMPOSE the named exports by hand against
 * a filesystem. This asserts the two produce byte-identical HTML for a real
 * fixture page — if a future edit reorders or drops a transform inside `fetch`,
 * this goes red.
 *
 * Behavioural, not source-introspecting: it drives `worker.fetch` for real and
 * diffs the served bytes.
 */

// `.href` because this tsconfig's only lib is @cloudflare/workers-types, whose
// global URL is not structurally node:url's.
const TEMPLATE_DIR = fileURLToPath(new URL('../../', import.meta.url).href);
const PUBLIC_DIR = join(TEMPLATE_DIR, 'public') + '/';

/**
 * ⚠ THIS FILE SHIPS TO EVERY V3 SITE REPO AND GATES ITS DEPLOY. ⚠
 *
 * `V3_REDEPLOY_SCAFFOLDING` (packages/cms/src/api/sites/site-runtime.ts) keeps
 * everything outside `public/`, and `filterV3RuntimeSeed`
 * (packages/cms/src/api/sites/import.ts) keeps `src/__tests__/*`, so
 * `ensureSiteRuntimeCurrent` auto-commits this file into live site repos. Each
 * site's `deploy.yml` then runs `pnpm typecheck` AND `pnpm test` BEFORE
 * deploying (packages/shared/src/workflows/deploy.ts).
 *
 * A failure here therefore fails a real site's deploy — and the self-heal
 * commit lands even when the deploy goes red, so the live worker would stay on
 * the old resolver while links.json already assumed the new one.
 *
 * Every other bundled test is synthetic. The describes below are the only ones
 * that read the site's REAL public/ tree, and a real site's public/ is nothing
 * like the template's — a legacy-upgraded V1/V2 site has no `<!-- #include -->`
 * at all, because runtimeV3Upgrade never rewrites authored pages. So they run
 * ONLY in the pristine template and skip everywhere else. The synthetic
 * describes at the bottom of this file stay live on every site.
 *
 * If you add a test that touches PUBLIC_DIR, put it inside a guarded describe.
 */
const TEMPLATE_MARKER = 'Casino Brand — Placeholder Homepage';

function isPristineTemplate(): boolean {
	try {
		return readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf-8').includes(TEMPLATE_MARKER);
	} catch {
		return false; // no readable public/index.html → definitely not the template
	}
}

const IN_TEMPLATE = isPristineTemplate();
const HOST = 'site.example';
const RUM_TAG = 'tag_parity_0001';

/** links.json in the real schema-1.0 shape, incl. the shared per-language block. */
const LINKS_JSON = {
	schema_version: '1.0',
	site: { brand: 'casino-brand', default_lang: 'en', languages: ['en', 'sv'] },
	assignments: [
		{
			assignment_id: 'asn_shared_en',
			code: 'shared-en',
			direction: 'outgoing',
			target_url: 'https://partner.example/track?c=en',
			slug: 'en/casino-brand',
			rel: 'sponsored nofollow',
		},
		{
			assignment_id: 'asn_shared_sv',
			code: 'shared-sv',
			direction: 'outgoing',
			target_url: 'https://partner.example/track?c=sv',
			slug: 'sv/casino-brand',
			rel: 'sponsored nofollow',
		},
		{
			assignment_id: 'asn_primary',
			code: 'primary-cta',
			direction: 'outgoing',
			target_url: 'https://partner.example/primary',
			slug: 'primary-offer',
		},
		{
			assignment_id: 'asn_direct',
			code: 'review-direct',
			direction: 'outgoing',
			target_url: 'https://partner.example/direct?src=seo',
			mode: 'direct',
			rel: 'sponsored',
		},
	],
};

/** CTA markup spliced into the real homepage — the shipped template fixture
 *  carries no `<aff-link>`, and the aff-link transform must be exercised. */
const CTA_BLOCK = [
	'<aff-link code="primary-cta" class="cta">Play now</aff-link>',
	'<aff-link code="review-direct">Read review</aff-link>',
	'<aff-link code="unassigned-slot">No assignment</aff-link>',
	// Inside an INCLUDED partial, so the output only resolves if includes ran
	// before aff-links. This is what pins the order of steps 1 and 2.
	'<!-- #include file="/partials/parity-cta.html" -->',
].join('\n');

const PARITY_PARTIAL_PATH = '/partials/parity-cta.html';
const PARITY_PARTIAL = '<div class="partial-cta"><aff-link code="primary-cta">In partial</aff-link></div>';

/** The real `public/index.html`, with the CTA block spliced into <main>. */
async function fixturePage(): Promise<string> {
	const real = await readFile(`${PUBLIC_DIR}index.html`, 'utf-8');
	expect(real).toContain('#include'); // guard: still the include-bearing fixture
	return real.replace('</main>', `${CTA_BLOCK}\n\t</main>`);
}

/** Overlay (synthetic) first, then the real files on disk under public/. */
async function readAsset(pathname: string, overlay: Record<string, string>): Promise<string | null> {
	if (overlay[pathname] !== undefined) return overlay[pathname];
	if (!pathname.startsWith('/') || pathname.includes('..')) return null;
	try {
		return await readFile(`${PUBLIC_DIR}${pathname.slice(1)}`, 'utf-8');
	} catch {
		return null;
	}
}

function mockEnv(overlay: Record<string, string>): Env {
	return {
		RUM_SITE_TAG: RUM_TAG,
		ASSETS: {
			async fetch(req: Request): Promise<Response> {
				const pathname = new URL(req.url).pathname;
				// Emulate wrangler's `html_handling: "auto-trailing-slash"`:
				// `/sv` resolves to sv.html, `/sv/` to sv/index.html.
				const candidates = pathname.endsWith('/')
					? [`${pathname}index.html`]
					: [pathname, `${pathname}.html`, `${pathname}/index.html`];
				let key = pathname;
				let body: string | null = null;
				for (const candidate of candidates) {
					body = await readAsset(candidate, overlay);
					if (body !== null) {
						key = candidate;
						break;
					}
				}
				if (body === null) return new Response('Not Found', { status: 404 });
				const type = key.endsWith('.json')
					? 'application/json'
					: key.endsWith('.html')
						? 'text/html; charset=utf-8'
						: 'text/plain';
				return new Response(body, { status: 200, headers: { 'Content-Type': type } });
			},
		} as unknown as Fetcher,
	};
}

/** The fs-style loader a non-Worker host injects into processIncludes. */
function fsLoader(overlay: Record<string, string>): PartialLoader {
	return (filePath) => readAsset(filePath, overlay);
}

/** Synthetic assets layered over the real public/ tree for one case. */
function overlayFor(
	page: string,
	links: unknown,
	extraPages: Record<string, string> = {}
): Record<string, string> {
	const overlay: Record<string, string> = {
		'/index.html': page,
		'/links.json': JSON.stringify(links),
		[PARITY_PARTIAL_PATH]: PARITY_PARTIAL,
	};
	for (const [rel, html] of Object.entries(extraPages)) overlay[`/${rel}`] = html;
	return overlay;
}

/**
 * A non-default-locale page in BOTH shapes the fleet actually uses:
 * `sv/index.html` (what the V3 builder emits) and `sv.html` (what IMPORTED
 * sites carry). The worker serves them at `/sv/` and `/sv` respectively.
 */
const SV_PAGE = `<!doctype html>
<html lang="sv"><head><title>SV</title></head><body>
<!-- #include file="/partials/header.html" -->
<main><aff-link code="primary-cta" class="cta">Spela nu</aff-link></main>
<footer><span data-year>2020</span></footer>
</body></html>`;

const LOCALE_PAGES = { 'sv.html': SV_PAGE, 'sv/index.html': SV_PAGE };

/**
 * The pipeline exactly as a Phase-1 host composes it from the named exports —
 * hand-written here on purpose, so it is an INDEPENDENT statement of the order
 * rather than a call into the Worker's own code.
 */
async function composeFromExports(
	pathname: string,
	html: string,
	overlay: Record<string, string>
): Promise<string> {
	const raw = await readAsset('/links.json', overlay);
	const links = raw === null ? parseLinksJson(null) : parseLinksJson(JSON.parse(raw));
	const token = resolveSharedAffToken(links, pathname);
	let out = await processIncludes(html, fsLoader(overlay));
	out = processAffLinks(out, links.byCode, token ? { sharedToken: token } : undefined);
	out = processYearToken(out);
	out = processCfBeacon(out, RUM_TAG);
	out = processCssInject(out);
	return out;
}

// Reads the real public/ tree — template only. See the banner at the top.
describe.skipIf(!IN_TEMPLATE)('exported transform set vs the worker request path', () => {
	beforeEach(() => {
		// processYearToken() reads the clock; freeze it so both paths agree even
		// across a New Year boundary.
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2027-03-04T05:06:07Z'));
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	// Both aff-link branches: `site` present → shared per-language token;
	// `site` absent (every legacy build) → per-code + unresolved fallback.
	const LEGACY_LINKS_JSON = { ...LINKS_JSON, site: undefined };

	it.each([
		['shared per-language links.json', LINKS_JSON],
		['legacy links.json (no site block)', LEGACY_LINKS_JSON],
	])('produces byte-identical HTML for the real public/index.html — %s', async (_name, links) => {
		const page = await fixturePage();
		const overlay = overlayFor(page, links);

		const res = await worker.fetch(new Request(`https://${HOST}/`), mockEnv(overlay));
		expect(res.status).toBe(200);
		const fromWorker = await res.text();
		const fromExports = await composeFromExports('/', page, overlay);

		expect(fromExports).toBe(fromWorker);
	});

	it('the shared-token output actually exercised every transform', async () => {
		const page = await fixturePage();
		const overlay = overlayFor(page, LINKS_JSON);
		const out = await composeFromExports('/', page, overlay);

		// includes: the real partials spliced, none failed
		expect(out).not.toContain('#include');
		expect(out).not.toContain('include failed');
		expect(out).toContain('class="site-header"');
		expect(out).toContain('class="site-footer"');
		// aff-links: the shared per-language token serves EVERY non-direct CTA —
		// including the otherwise-unassigned slot, which is why no unresolved
		// placeholder survives on a shared-token page.
		// 3 = primary-cta + unassigned-slot in the page, + primary-cta inside the
		// included partial (which only resolves because includes ran first).
		expect(out).not.toMatch(/<aff-link\s/);
		expect((out.match(/href="\/go\/en\/casino-brand"/g) ?? []).length).toBe(3);
		expect(out).toContain('class="partial-cta"');
		expect(out).not.toContain('title="Unassigned affiliate slot"');
		// direct mode bypasses the shared token
		expect(out).toContain('href="https://partner.example/direct?src=seo"');
		// year, beacon, css inject
		expect(out).toContain('<span data-year>2027</span>');
		expect((out.match(/beacon\.min\.js/g) ?? []).length).toBe(1);
		expect(out).toContain(RUM_TAG);
		expect((out.match(/levr-legacy-fixes/g) ?? []).length).toBe(1);
	});

	it('the legacy (no site block) output takes the per-code + unresolved branches', async () => {
		const page = await fixturePage();
		const overlay = overlayFor(page, LEGACY_LINKS_JSON);
		const out = await composeFromExports('/', page, overlay);

		expect(resolveSharedAffToken(parseLinksJson(LEGACY_LINKS_JSON), '/')).toBeUndefined();
		// per-code: primary-cta resolves through its own pretty slug, not the shared one
		expect(out).toContain('href="/go/primary-offer"');
		expect(out).not.toContain('/go/en/casino-brand');
		expect(out).toContain('href="https://partner.example/direct?src=seo"');
		// and the unassigned slot now really does degrade
		expect(out).toContain('title="Unassigned affiliate slot"');
	});

	it('the worker sets exactly the exported SECURITY_HEADERS + cacheHeadersFor values', async () => {
		const overlay = overlayFor(await fixturePage(), LINKS_JSON);
		const res = await worker.fetch(new Request(`https://${HOST}/`), mockEnv(overlay));

		// Literals, not `Object.entries(SECURITY_HEADERS)` — comparing the export
		// against itself would pass no matter what either side became.
		expect(SECURITY_HEADERS).toEqual({
			'X-Content-Type-Options': 'nosniff',
			'X-Frame-Options': 'SAMEORIGIN',
			'Referrer-Policy': 'strict-origin-when-cross-origin',
			'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
		});
		expect(cacheHeadersFor('/', 'text/html')).toEqual({
			'Cache-Control': 'public, max-age=300, must-revalidate',
		});
		expect(cacheHeadersFor('/assets/og-default.png', 'image/png')).toEqual({
			'Cache-Control': 'public, max-age=31536000, immutable',
		});

		// ...and the worker's served response actually carries them.
		for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
			expect(res.headers.get(k)).toBe(v);
		}
		for (const [k, v] of Object.entries(cacheHeadersFor('/', 'text/html'))) {
			expect(res.headers.get(k)).toBe(v);
		}
	});

	it('/go/ resolution matches parseGoAssignments + resolveGoAssignment + buildRedirectTarget', async () => {
		const overlay = { '/links.json': JSON.stringify(LINKS_JSON) };
		const search = '?utm_source=parity&a=1';

		const res = await worker.fetch(
			new Request(`https://${HOST}/go/en/casino-brand${search}`),
			mockEnv(overlay)
		);
		expect(res.status).toBe(302);

		const hit = resolveGoAssignment(parseGoAssignments(LINKS_JSON), 'en/casino-brand');
		expect(hit?.assignment_id).toBe('asn_shared_en');
		const expected = buildRedirectTarget(hit!.target_url!, search);

		expect(res.headers.get('location')).toBe(expected);
		// the target already carries a query, so passthrough must append with '&'
		expect(expected).toBe('https://partner.example/track?c=en&utm_source=parity&a=1');
	});

	it('an unresolvable /go/ token 404s on both paths', async () => {
		const overlay = { '/links.json': JSON.stringify(LINKS_JSON) };
		const res = await worker.fetch(new Request(`https://${HOST}/go/nope`), mockEnv(overlay));
		expect(res.status).toBe(404);
		expect(resolveGoAssignment(parseGoAssignments(LINKS_JSON), 'nope')).toBeNull();
	});
});

describe('parseLinksJson keeps the worker filter', () => {
	it('drops non-outgoing / code-less entries and degrades on a bad schema', () => {
		const links = parseLinksJson({
			schema_version: '1.0',
			site: { brand: 'b', default_lang: 'en', languages: ['en'] },
			assignments: [
				{ assignment_id: 'a1', code: 'keep', direction: 'outgoing', target_url: 'https://x', slug: 'keep-me' },
				{ assignment_id: 'a2', code: 'drop', direction: 'incoming', target_url: 'https://y' },
				{ assignment_id: 'a3', direction: 'outgoing', target_url: 'https://z', slug: 'no-code' },
			],
		});
		expect([...links.byCode.keys()]).toEqual(['keep']);
		expect([...links.bySlug.keys()]).toEqual(['keep-me']);
		expect(links.site?.brand).toBe('b');

		const bad = parseLinksJson({ schema_version: '0.9', assignments: [] });
		expect(bad.byCode.size).toBe(0);
		expect(bad.site).toBeUndefined();
	});

	it('parseGoAssignments is looser than parseLinksJson: a code-less assignment still routes', () => {
		const body = {
			schema_version: '1.0',
			assignments: [
				{ assignment_id: 'a3', direction: 'outgoing', target_url: 'https://z', slug: 'no-code' },
			],
		};
		expect(parseLinksJson(body).bySlug.size).toBe(0);
		expect(resolveGoAssignment(parseGoAssignments(body), 'no-code')?.assignment_id).toBe('a3');
	});
});

/**
 * THREE-WAY parity: worker === render-static === hand-composed exports.
 *
 * `scripts/render-static.mts` is the parity ORACLE the BigCloudy plan (§8
 * step 3) diffs the new origin runtime against, so the oracle itself has to
 * match the worker. It did NOT: it never computed the shared per-language
 * token, so on a site with a `site` block it emitted per-code `/go/{slug}`
 * where the worker emits one shared `/go/{lang}/{brand}`.
 *
 * This runs the real CLI as a subprocess against a real fixture tree, which is
 * exactly how Phase 1 will use it — no importing of internals, no mocking.
 */

const execFileAsync = promisify(execFile);
const TSX_CLI = join(TEMPLATE_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const RENDER_STATIC = join(TEMPLATE_DIR, 'scripts', 'render-static.mts');
const FIXED_YEAR = 2027;

/** render-static appends this static-only updater AFTER the worker chain — the
 *  one DOCUMENTED difference. Stripping it is what makes the diff meaningful;
 *  asserting it was present first stops the strip from silently no-op'ing. */
const YEAR_UPDATER =
	`<script>for(var e=document.querySelectorAll('span[data-year]'),i=0;i<e.length;i++)e[i].textContent=new Date().getFullYear();</script>`;

/**
 * Run the real render-static CLI over a fixture tree and return the rendered
 * HTML for each requested page, with the static-only year-updater stripped.
 */
async function renderStaticPages(
	pages: Record<string, string>,
	links: unknown
): Promise<Record<string, string>> {
	const dir = await mkdtemp(join(tmpdir(), 'levr-parity-'));
	try {
		const pub = join(dir, 'public');
		// Start from the REAL public/ so the partials are the shipped ones.
		await cp(PUBLIC_DIR, pub, { recursive: true });
		await mkdir(join(pub, 'partials'), { recursive: true });
		await writeFile(join(pub, 'partials', 'parity-cta.html'), PARITY_PARTIAL, 'utf-8');
		await writeFile(join(pub, 'links.json'), JSON.stringify(links), 'utf-8');
		for (const [rel, html] of Object.entries(pages)) {
			const dest = join(pub, rel);
			await mkdir(join(dest, '..'), { recursive: true });
			await writeFile(dest, html, 'utf-8');
		}

		await execFileAsync(
			process.execPath,
			[TSX_CLI, RENDER_STATIC, '--base', 'public', '--out', 'dist', '--year', String(FIXED_YEAR), '--rum-tag', RUM_TAG],
			{ cwd: dir }
		);

		const out: Record<string, string> = {};
		for (const rel of Object.keys(pages)) {
			const html = await readFile(join(dir, 'dist', rel), 'utf-8');
			expect(html).toContain(YEAR_UPDATER);
			out[rel] = html.replace(`${YEAR_UPDATER}\n`, '');
		}
		return out;
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

// Reads the real public/ tree + runs the CLI over it — template only.
describe.skipIf(!IN_TEMPLATE)('three-way parity: worker === render-static === exported set', () => {
	let page = '';

	// Real timers here: the render-static runs happen in beforeAll, and only the
	// worker/composed calls need a frozen clock.
	beforeAll(async () => {
		page = await fixturePage();
	});

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date(`${FIXED_YEAR}-03-04T05:06:07Z`));
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	const LEGACY_LINKS_JSON = { ...LINKS_JSON, site: undefined };

	it.each([
		['shared per-language site block', LINKS_JSON, '/go/en/casino-brand'],
		['legacy links.json (no site block)', LEGACY_LINKS_JSON, '/go/primary-offer'],
	])(
		'render-static matches the worker byte-for-byte — %s',
		async (_name, links, expectedHref) => {
			// render-static runs with real timers, before the clock is frozen.
			vi.useRealTimers();
			const rendered = await renderStaticPages({ 'index.html': page }, links);
			vi.useFakeTimers({ toFake: ['Date'] });
			vi.setSystemTime(new Date(`${FIXED_YEAR}-03-04T05:06:07Z`));

			const overlay = overlayFor(page, links);
			const res = await worker.fetch(new Request(`https://${HOST}/`), mockEnv(overlay));
			const fromWorker = await res.text();
			const fromExports = await composeFromExports('/', page, overlay);

			// The link shape is the thing the divergence got wrong — assert it
			// concretely, not just that three strings happen to be equal.
			expect(fromWorker).toContain(`href="${expectedHref}"`);
			expect(rendered['index.html']).toContain(`href="${expectedHref}"`);

			expect(rendered['index.html']).toBe(fromWorker);
			expect(fromExports).toBe(fromWorker);
		},
		30_000
	);

	/**
	 * Non-default-locale pages in BOTH on-disk shapes. `sv/index.html` (what the
	 * V3 builder emits) worked already; `sv.html` (what IMPORTED sites carry, and
	 * re-hosting imported sites is the point of BigCloudy) did NOT — render-static
	 * read its first path segment as "sv.html", missed the `languages` list, and
	 * rendered the DEFAULT language's affiliate link on the Swedish page.
	 *
	 * The root index.html corpus alone could never catch this: it has no
	 * non-default-locale page in it at all.
	 */
	it(
		'a non-default-locale page gets ITS language link in both on-disk shapes',
		async () => {
			vi.useRealTimers();
			const rendered = await renderStaticPages({ 'index.html': page, ...LOCALE_PAGES }, LINKS_JSON);
			vi.useFakeTimers({ toFake: ['Date'] });
			vi.setSystemTime(new Date(`${FIXED_YEAR}-03-04T05:06:07Z`));

			const overlay = overlayFor(page, LINKS_JSON, LOCALE_PAGES);

			// file on disk -> the URL the worker serves it at
			for (const [rel, servedPath] of [
				['sv.html', '/sv'],
				['sv/index.html', '/sv/'],
			] as const) {
				const res = await worker.fetch(new Request(`https://${HOST}${servedPath}`), mockEnv(overlay));
				expect(res.status).toBe(200);
				const fromWorker = await res.text();
				const fromExports = await composeFromExports(servedPath, SV_PAGE, overlay);

				// The Swedish page must carry the SWEDISH token, not the default one.
				expect(fromWorker).toContain('href="/go/sv/casino-brand"');
				expect(fromWorker).not.toContain('/go/en/casino-brand');
				expect(rendered[rel]).toContain('href="/go/sv/casino-brand"');
				expect(rendered[rel]).not.toContain('/go/en/casino-brand');

				expect(rendered[rel]).toBe(fromWorker);
				expect(fromExports).toBe(fromWorker);
			}

			// ...while the default-locale root page still resolves to `en`.
			expect(rendered['index.html']).toContain('href="/go/en/casino-brand"');
		},
		30_000
	);

	it('render-static emits /go/ tokens for code-less assignments, like the worker', async () => {
		vi.useRealTimers();
		// A code-less assignment is routable via /go/ but never renders as an
		// <aff-link> — the deliberate parseGoAssignments/parseLinksJson asymmetry.
		const links = {
			...LINKS_JSON,
			assignments: [
				...LINKS_JSON.assignments,
				{
					assignment_id: 'asn_nocode',
					direction: 'outgoing',
					// The apostrophe pins the SHARED escapeHtmlAttr: render-static's
					// old private copy did not escape `'`.
					target_url: "https://partner.example/nocode?q='x'",
					slug: 'no-code-token',
				},
			],
		};
		const dir = await mkdtemp(join(tmpdir(), 'levr-parity-go-'));
		try {
			const pub = join(dir, 'public');
			await cp(PUBLIC_DIR, pub, { recursive: true });
			await writeFile(join(pub, 'links.json'), JSON.stringify(links), 'utf-8');
			await execFileAsync(process.execPath, [TSX_CLI, RENDER_STATIC, '--base', 'public', '--out', 'dist'], {
				cwd: dir,
			});
			const stub = await readFile(join(dir, 'dist', 'go', 'no-code-token', 'index.html'), 'utf-8');
			expect(stub).toContain('https://partner.example/nocode');
			// One escaper, shared with the worker: `'` → `&#39;` in attributes.
			expect(stub).toContain('nocode?q=&#39;x&#39;');
			expect(stub).not.toContain("nocode?q='x'");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);
});
