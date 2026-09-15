/**
 * V3 Casino Site Runtime Worker
 *
 * Server-Side-Include (SSI) processor for V3 agentic-built sites.
 *
 * Pattern lifted from xndr.io's worker (src/index.ts:1643) — re-implemented
 * clean. Intercepts every request via `run_worker_first: true`, fetches the
 * underlying static asset from the ASSETS binding, and for HTML responses
 * resolves any `<!-- #include file="..." -->` directives by splicing in the
 * referenced partial. Non-HTML responses pass through untouched (cache +
 * security headers added).
 *
 * Constraints (from V3 plan):
 * - ~150 LOC, no nested includes (one-pass resolve only)
 * - Absolute paths only (file="/partials/header.html")
 * - links.json is loaded at request time. Outgoing-only by schema —
 *   `<aff-link code="X">CTA</aff-link>` resolves to `<a href="/go/{id}">`
 *   when an assignment exists, else falls back to a styled `<span>`. See
 *   `docs/v3-site-source-format.md` § "Affiliate link integration".
 * - levr.json is build-time only — agent embeds the relevant bits into HTML
 *
 * Source of truth: public HTML pages (public/), partials
 * (public/partials/), levr.json, and links.json — all stored in the
 * site repo. This Worker is a thin runtime.
 *
 * PORTABLE TRANSFORM SURFACE
 * --------------------------
 * Every request-time transform is exported as an I/O-free (or loader-injected)
 * function so a non-Worker host — `scripts/render-static.mts`, and the
 * BigCloudy Node origin adapter (`docs/bigcloudy-deploy-plan.md` §2) — runs the
 * IDENTICAL code instead of a second implementation that drifts.
 *
 * HTML pipeline — the canonical order, exactly as the fetch handler below
 * applies it to both the 200 and the /404.html body:
 *   1. processIncludes(html, loadFile)            // SSI partials; inject the I/O
 *   2. processAffLinks(html, byCode, affOpts)     // affOpts = { sharedToken } | undefined
 *   3. processYearToken(html, year?)              // omit `year` for request-time
 *   4. processCfBeacon(html, rumSiteTag)
 *   5. processCssInject(html)
 *
 * Inputs a host must build first:
 *   - loadFile: a `PartialLoader`. Worker → `assetsPartialLoader(env, host)`;
 *     filesystem hosts → read `<public>/<path>`, null when missing.
 *   - links: `parseLinksJson(JSON.parse(<public>/links.json))` → `{ byCode,
 *     bySlug, site }`. Throwing/missing/wrong-schema MUST degrade to empty maps
 *     (unresolved `<aff-link>` spans are the designed fallback).
 *   - affOpts: `resolveSharedAffToken(links, pathname)` → token | undefined,
 *     wrapped as `token ? { sharedToken: token } : undefined`.
 *
 * `/go/{token}` — `resolveGoAssignment(parseGoAssignments(body), token)` then
 * `buildRedirectTarget(hit.target_url, search)` → 302. Note the deliberate
 * asymmetry: `/go/` resolution accepts assignments that `parseLinksJson` drops
 * (it does not require a `code`), so keep the two parsers distinct.
 *
 * Response headers: `SECURITY_HEADERS` on every response, plus
 * `cacheHeadersFor(pathname, contentType)`.
 */

import { V3_RUNTIME_VERSION } from './version.gen';

export interface Env {
	ASSETS: Fetcher;
	// Optional CF Workers Analytics Engine binding for /go/:id click logs.
	// Site repos may not declare it; the handler falls back to console.log.
	ANALYTICS?: AnalyticsEngineDataset;
	// Optional separate Analytics Engine dataset for /api/analytics pageview
	// beacons (binding PAGEVIEWS → dataset levr_pageviews). Kept distinct from
	// ANALYTICS (levr_aff_clicks) so pageview volume doesn't pollute click data.
	PAGEVIEWS?: AnalyticsEngineDataset;
	// Cloudflare Web Analytics (RUM) site_tag, build-substituted into
	// wrangler.jsonc [vars] by deploy_worker for ZONED sites (custom domain)
	// only. When present, the served-HTML rewrite injects the beacon.min.js
	// script with this token; the CMS/cron readers query visits/pageviews for
	// the same tag. Absent (workers.dev-only / not provisioned) → no beacon.
	RUM_SITE_TAG?: string;
}

/**
 * Build a lookup map keyed by assignment_id from a parsed links.json
 * assignments array. /go/:id uses this to resolve redirect targets.
 *
 * Exported for unit tests.
 */
export function indexAssignmentsById(
	assignments: LinksAssignment[]
): Map<string, LinksAssignment> {
	const out = new Map<string, LinksAssignment>();
	for (const a of assignments) {
		if (!a || a.direction !== 'outgoing') continue;
		if (typeof a.assignment_id !== 'string' || !a.assignment_id) continue;
		if (typeof a.target_url !== 'string' || !a.target_url) continue;
		out.set(a.assignment_id, a);
	}
	return out;
}

/**
 * Build a lookup map keyed by pretty `slug` from a parsed links.json
 * assignments array. /go/:token resolves slug-first (then falls back to
 * assignment_id). Entries whose slug fails `SLUG_RE` (lowercase [a-z0-9-]
 * segments, optionally slash-joined like `en/starzino`) are skipped so a
 * malformed slug can never shadow an assignment_id.
 *
 * Exported for unit tests.
 */
export function indexAssignmentsBySlug(
	assignments: LinksAssignment[]
): Map<string, LinksAssignment> {
	const out = new Map<string, LinksAssignment>();
	for (const a of assignments) {
		if (!a || a.direction !== 'outgoing') continue;
		if (typeof a.slug !== 'string' || !SLUG_RE.test(a.slug)) continue;
		if (typeof a.target_url !== 'string' || !a.target_url) continue;
		out.set(a.slug, a);
	}
	return out;
}

/**
 * Compose the final redirect target by appending the incoming request's
 * query string onto the assignment's `target_url`. Preserves any existing
 * query string on the target (`?` becomes `&`). Exported for tests.
 */
export function buildRedirectTarget(targetUrl: string, incomingSearch: string): string {
	if (!incomingSearch) return targetUrl;
	const qs = incomingSearch.startsWith('?') ? incomingSearch.slice(1) : incomingSearch;
	if (!qs) return targetUrl;
	// Split off any fragment first so the appended query lands BEFORE it —
	// otherwise `https://t/x#frag` + `?a=b` → `https://t/x#frag?a=b`, trapping the
	// passthrough query inside the fragment where the destination never sees it.
	const hashIdx = targetUrl.indexOf('#');
	const base = hashIdx === -1 ? targetUrl : targetUrl.slice(0, hashIdx);
	const frag = hashIdx === -1 ? '' : targetUrl.slice(hashIdx);
	const sep = base.includes('?') ? '&' : '?';
	return `${base}${sep}${qs}${frag}`;
}

/**
 * Valid pretty-slug charset. Lowercase `[a-z0-9-]` segments joined by single
 * `/` — so a slug can be a single token (`log-in-17`) OR a multi-segment path
 * (`en/starzino`) rendering as `/go/en/starzino`. No leading/trailing/double
 * slash. Single-segment slugs are the backward-compatible subset (the `(?:…)*`
 * group matches zero times). Shared by the resolver + the `<aff-link>` writer
 * so both agree on what a routable slug looks like.
 */
export const SLUG_RE = /^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/;

// `/go/<token>` — token is one OR more path segments (pretty slug may contain
// slashes, e.g. `en/starzino`), stopping before any query/hash. A trailing
// slash is tolerated and stripped by the optional `\/?`. Exported for tests.
export const GO_PATH_REGEX = /^\/go\/([^?#]+?)\/?$/;

/**
 * The language of the page at `pathname`, for the shared per-language Pretty
 * Link model. The first path segment is the page locale IFF it is one of the
 * build `languages` and NOT the default (default-locale pages ship WITHOUT a
 * prefix). Anything else → the default language. Exported for tests.
 */
export function pageLangFromPath(pathname: string, site: LinksSiteBlock | undefined): string {
	const def = (site?.default_lang || '').toLowerCase();
	const langs = (site?.languages ?? []).map((l) => (l || '').toLowerCase()).filter(Boolean);
	const first = pathname.replace(/^\/+/, '').split('/')[0]?.toLowerCase() ?? '';
	if (first && first !== def && langs.includes(first)) return first;
	return def || langs[0] || 'en';
}

/**
 * The shared `/go` token for a page — `{lang}/{brand}` — or null when the site
 * block carries no brand (so the caller falls back to per-code rendering).
 * Slug-safe: both halves are lowercased + non-[a-z0-9-] collapsed to '-'.
 * Exported for tests.
 */
export function sharedAffToken(pageLang: string, site: LinksSiteBlock | undefined): string | null {
	const brand = (site?.brand || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
	if (!brand) return null;
	const lang = (pageLang || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
	if (!lang) return null;
	const token = `${lang}/${brand}`;
	return SLUG_RE.test(token) ? token : null;
}

const INCLUDE_REGEX = /<!--\s*#include\s+file="([^"]+)"([^>]*?)\s*-->/g;

/**
 * Locale-suffixed partial path → its default (un-suffixed) fallback.
 * `/partials/header.sv.html` → `/partials/header.html`. Returns null when the
 * path has no locale suffix (a plain `/partials/header.html` has no fallback).
 *
 * Pages on a non-default locale reference `header.<lang>.html`; if the build
 * forgot to write that localized partial, we degrade to the default chrome
 * rather than rendering a chrome-less page. Exported for unit tests.
 */
export function defaultPartialFallback(filePath: string): string | null {
	const m = filePath.match(/^(\/partials\/(?:header|footer))\.[a-z]{2}(?:-[a-z]{2})?\.html$/i);
	return m ? `${m[1]}.html` : null;
}
/**
 * `<aff-link code="primary-cta">CTA text</aff-link>` matcher. Body is
 * non-greedy `[\s\S]*?` so inline HTML inside the CTA (icons, spans) is
 * preserved when substituted into either the resolved <a> or unresolved
 * <span> form.
 *
 * Group 1 is the FULL attribute span (order-independent — `code` may be in any
 * position, e.g. `<aff-link class="btn" code="x">`); `extractAffCode` /
 * `parsePreservedAffAttrs` parse `code` and the preserved presentational attrs
 * out of it. This MUST stay in lockstep with the manager-side scanner
 * (`packages/cms/src/lib/aff-link-scanner.ts`), otherwise a slot the manager
 * counts as assigned would render inert here.
 */
const AFF_LINK_REGEX = /<aff-link\s+([^>]*?)>([\s\S]*?)<\/aff-link>/gi;

/** Pull the `code` value out of an `<aff-link>` attribute span (any position,
 *  single or double quoted). Returns null when absent. Exported for tests. */
export function extractAffCode(attrSpan: string): string | null {
	const m = attrSpan.match(/(?:^|\s)code\s*=\s*("([^"]*)"|'([^']*)')/i);
	if (!m) return null;
	return m[2] ?? m[3] ?? null;
}

/**
 * Parse the preserved presentational attributes off an `<aff-link>` span —
 * everything EXCEPT `code` (and the runtime-owned `href`/`data-aff`, which can
 * never legitimately be authored on the placeholder but are stripped for
 * defence-in-depth). Returns the carried `class`/`rel` values separately (for
 * the merge rules) plus the leftover attribute string (already escaped at the
 * source open tag; re-escaped here on the values we re-emit). Exported for tests.
 */
export function parsePreservedAffAttrs(attrSpan: string): {
	/** Attribute string for non-class/non-rel preserved attrs, no leading space. */
	rest: string;
	/** The preserved `class` value (raw), or null. */
	className: string | null;
	/** The preserved `rel` value (raw), or null. */
	rel: string | null;
} {
	const ATTR_RE = /([^\s=/]+)(\s*=\s*("[^"]*"|'[^']*'|[^\s>]*))?/g;
	const rest: string[] = [];
	let className: string | null = null;
	let rel: string | null = null;
	let m: RegExpExecArray | null;
	while ((m = ATTR_RE.exec(attrSpan)) !== null) {
		const name = m[1];
		if (!name) continue;
		const lower = name.toLowerCase();
		// Strip code (parsed separately) + runtime-owned attrs.
		if (lower === 'code' || lower === 'href' || lower === 'data-aff') continue;
		const valueRaw = m[3] ? m[3].slice(1, -1) : m[3] === '' ? '' : null;
		if (lower === 'class') {
			className = valueRaw ?? '';
			continue;
		}
		if (lower === 'rel') {
			rel = valueRaw ?? '';
			continue;
		}
		if (valueRaw === null) {
			rest.push(name); // boolean / valueless attr
		} else {
			rest.push(`${name}="${escapeHtmlAttr(valueRaw)}"`);
		}
	}
	return { rest: rest.join(' '), className, rel };
}

/**
 * V3 links.json record (matches packages/builder V3LinksAssignment). The
 * runtime only cares about `code`, `direction`, and `assignment_id` —
 * everything else (target_url, label) is dashboard-only.
 *
 * `direction === 'outgoing'` is required: an entry without it is treated
 * as unresolved (defence-in-depth even though the schema gate at the
 * builder side already enforces this).
 */
export interface LinksAssignment {
	assignment_id: string;
	code: string;
	direction: 'outgoing';
	target_url?: string;
	label?: string;
	/** Optional pretty slug for /go/:slug. Lowercase [a-z0-9-]. Additive —
	 *  assignments without one still resolve by assignment_id. */
	slug?: string;
	/** Link rendering mode. Absent/'redirect' = tracked /go/ 302 hop (default).
	 *  'direct' = plain do-follow `<a href="{target_url}">` — no /go/ hop, passes
	 *  SEO juice, sellable, not click-tracked. */
	mode?: 'redirect' | 'direct';
	/** Optional rel attribute value (already validated/normalised at write time
	 *  by the manager). Absent/empty = none (do-follow). */
	rel?: string;
}

/**
 * Optional site-level block on links.json. Present ONLY on builds that opted
 * into the shared per-language Pretty Link model (operator 2026-07-17): ONE
 * `/go/{lang}/{brand}` link per language, shared across every page + CTA in
 * that language version, each language pointing at its own tracking URL.
 *
 * When present AND a matching `{lang}/{brand}` slug assignment exists, the
 * runtime renders that single shared token for EVERY `<aff-link>` on a page in
 * that language (keyed by the page's language + brand, NOT the per-CTA code).
 * When ABSENT (every legacy build), rendering falls back to the per-code slug/
 * assignment_id path — so existing sites are completely unaffected (additive).
 */
export interface LinksSiteBlock {
	/** Brand slug — the `{brand}` half of `/go/{lang}/{brand}`. */
	brand?: string;
	/** Default language (the locale with no path prefix). */
	default_lang?: string;
	/** All build languages (locale-prefixed segments to recognise). */
	languages?: string[];
}

export interface LinksJson {
	schema_version: '1.0';
	assignments?: LinksAssignment[];
	site?: LinksSiteBlock;
}

/** POST /api/analytics beacon body. All fields optional — the handler defaults
 *  event→'pageview', page→url.pathname, value→1. */
interface PageviewEvent {
	event?: string;
	page?: string;
	value?: number;
}

/**
 * Unauthenticated health response. Mirrors the V1/V2 single-file worker's
 * /api/health so the CMS upgrade-check (status.ts → /worker-health) can read
 * `version` and compare it against FILES_VERSION via compareVersions. Version
 * is baked at codegen time (version.gen.ts) because the V3 build path commits
 * template files verbatim — no {{placeholder}} substitution. Exported for tests.
 */
export function handleHealth(): Response {
	return Response.json({
		status: 'ok',
		version: V3_RUNTIME_VERSION,
		runtime: 'agentic_v3',
		timestamp: Date.now(),
	});
}

/**
 * POST /api/analytics — pageview beacon. Writes one datapoint to the PAGEVIEWS
 * dataset (levr_pageviews) when bound; emit-only (the CMS-side reader is task
 * #102, out of scope here). try/catch so a telemetry failure never 500s the
 * beacon. Always 204. Exported for tests.
 */
export async function handlePageview(request: Request, env: Env, url: URL): Promise<Response> {
	try {
		const data = (await request.json().catch(() => ({}))) as PageviewEvent;
		if (env.PAGEVIEWS && typeof env.PAGEVIEWS.writeDataPoint === 'function') {
			env.PAGEVIEWS.writeDataPoint({
				blobs: [data.event || 'pageview', data.page || url.pathname, url.host],
				indexes: [url.host],
				doubles: [data.value ?? 1],
			});
		}
	} catch {
		// Telemetry must never fail the beacon.
	}
	return new Response(null, { status: 204 });
}

/**
 * Cheap UA bucket for the pageview datapoint. Three classes only — `bot`,
 * `mobile`, `desktop` — derived from a regex over the User-Agent. Bots are
 * detected first (and excluded from emit by emitPageview) to control AE volume.
 * Exported for unit tests.
 */
export function classifyDevice(ua: string): 'bot' | 'mobile' | 'desktop' {
	if (/bot|crawl|spider|slurp|bingpreview|headless|monitor|curl|wget|python-requests|facebookexternalhit/i.test(ua)) {
		return 'bot';
	}
	if (/Mobi|Android|iPhone|iPad|iPod|Opera Mini|IEMobile/i.test(ua)) {
		return 'mobile';
	}
	return 'desktop';
}

/**
 * Host-only of a Referer header (strip path + query). PRIVACY: we record where
 * traffic came FROM at host granularity only — never a full URL (no PII, no
 * query strings). '' when there's no/invalid Referer. Exported for tests.
 */
export function refererHost(referer: string | null): string {
	if (!referer) return '';
	try {
		return new URL(referer).host;
	} catch {
		return '';
	}
}

/**
 * Server-side pageview emit. Fires ONE datapoint into the PAGEVIEWS dataset
 * (levr_pageviews) per HTML response. Schema mirrors the levr_aff_clicks
 * convention (blob/index/double ordering — index1 = host so reads can filter
 * by site exactly as aff-clicks does):
 *
 *   blobs:   [host, pathname, refHost, country, deviceClass]
 *   indexes: [host]
 *   doubles: [1]
 *
 * Skips obvious bots (cheap UA check) to control AE volume. Fire-and-forget,
 * fully wrapped in try/catch — telemetry NEVER breaks or delays the response.
 * The writeDataPoint enqueue is synchronous/non-blocking (same as the aff-click
 * write); ctx.waitUntil is used when available purely as a safety net.
 */
function emitPageview(request: Request, env: Env, url: URL, ctx?: ExecutionContext): void {
	try {
		if (!env.PAGEVIEWS || typeof env.PAGEVIEWS.writeDataPoint !== 'function') return;
		const ua = request.headers.get('User-Agent') || '';
		const deviceClass = classifyDevice(ua);
		if (deviceClass === 'bot') return; // skip bots to control volume
		const refHost = refererHost(request.headers.get('Referer'));
		const country = (request as { cf?: { country?: string } }).cf?.country || '';
		const write = () =>
			env.PAGEVIEWS!.writeDataPoint({
				blobs: [url.host, url.pathname, refHost, country, deviceClass],
				indexes: [url.host],
				doubles: [1],
			});
		if (ctx && typeof ctx.waitUntil === 'function') {
			ctx.waitUntil(Promise.resolve().then(write).catch(() => {}));
		} else {
			write();
		}
	} catch {
		// Telemetry must never break the response.
	}
}

/**
 * GET /favicon.ico — serve the site's SVG favicon. V3 sites ship a single
 * text `public/favicon.svg` (no binary .ico — binaries can't ride the
 * text-only runtime-seed createCommit path, see filterV3RuntimeSeed). Browsers
 * request `/favicon.ico` unconditionally regardless of the <link> tags, so we
 * intercept it and return the SVG bytes (modern browsers render SVG favicons)
 * — no 404, no binary asset. Missing favicon.svg → 404 (correct: nothing to
 * serve). Exported for unit tests.
 */
export async function handleFaviconIco(env: Env, host: string): Promise<Response> {
	const svgUrl = new URL('/favicon.svg', `https://${host}`);
	const res = await env.ASSETS.fetch(new Request(svgUrl.toString()));
	if (!res.ok) {
		return new Response('Not Found', {
			status: 404,
			headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-cache' },
		});
	}
	return new Response(res.body, {
		status: 200,
		headers: {
			'Content-Type': 'image/svg+xml',
			'Cache-Control': 'public, max-age=31536000, immutable',
		},
	});
}

/** HTML attribute-value escape. Exported so non-Worker hosts share ONE escaper —
 *  render-static previously carried a private copy that did not escape `'`. */
export function escapeHtmlAttr(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

/**
 * Render a leading-space ` rel="..."` attribute for an assignment, or '' when
 * it carries no rel. Defence-in-depth: the manager validates/normalises rel at
 * write time, but the runtime re-validates against the allowed set so a hand-
 * edited links.json can't inject arbitrary attribute content. Token-order
 * independent (`nofollow sponsored` → `sponsored nofollow`). Exported for tests.
 */
export function relAttr(rel: string | undefined): string {
	if (!rel) return '';
	const tokens = rel.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return '';
	const set = new Set(tokens);
	for (const t of set) {
		if (t !== 'nofollow' && t !== 'sponsored') return '';
	}
	let value = '';
	if (set.has('sponsored') && set.has('nofollow')) value = 'sponsored nofollow';
	else if (set.has('sponsored')) value = 'sponsored';
	else if (set.has('nofollow')) value = 'nofollow';
	return value ? ` rel="${escapeHtmlAttr(value)}"` : '';
}

/** Applied to every response the runtime emits. Exported so a non-Worker host
 *  sets the same headers (header parity is part of the parity gate). */
export const SECURITY_HEADERS: Record<string, string> = {
	'X-Content-Type-Options': 'nosniff',
	'X-Frame-Options': 'SAMEORIGIN',
	'Referrer-Policy': 'strict-origin-when-cross-origin',
	'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
};

/** Cache-Control for a served path, by content type then extension. Exported
 *  so a non-Worker host reproduces the same caching posture. */
export function cacheHeadersFor(pathname: string, contentType: string): Record<string, string> {
	if (contentType.includes('text/html')) {
		return { 'Cache-Control': 'public, max-age=300, must-revalidate' };
	}
	if (/\.(svg|png|jpe?g|webp|avif|gif|ico)$/i.test(pathname)) {
		return { 'Cache-Control': 'public, max-age=31536000, immutable' };
	}
	if (/\.(css|js|woff2?|ttf)$/i.test(pathname)) {
		return { 'Cache-Control': 'public, max-age=86400' };
	}
	return { 'Cache-Control': 'public, max-age=3600' };
}

function withHeaders(response: Response, extra: Record<string, string>): Response {
	const headers = new Headers(response.headers);
	for (const [k, v] of Object.entries({ ...SECURITY_HEADERS, ...extra })) {
		headers.set(k, v);
	}
	return new Response(response.body, { status: response.status, headers });
}

async function fetchPartial(env: Env, host: string, filePath: string): Promise<string | null> {
	// Absolute paths only — /partials/header.html
	if (!filePath.startsWith('/')) return null;
	const partialUrl = new URL(filePath, `https://${host}`);
	const res = await env.ASSETS.fetch(new Request(partialUrl.toString()));
	if (!res.ok) return null;
	return await res.text();
}

/**
 * Fetch links.json from the site's static assets and parse it. Returns an
 * empty assignment map on any failure (file missing, parse error, wrong
 * schema_version) — `<aff-link>` placeholders then all render as
 * unresolved spans, which is the correct fallback per the V3 design.
 */
export interface LoadedLinks {
	/** code → assignment (the per-CTA resolution map — legacy path). */
	byCode: Map<string, LinksAssignment>;
	/** slug → assignment (used to confirm a shared `{lang}/{brand}` token exists
	 *  before rendering it). */
	bySlug: Map<string, LinksAssignment>;
	/** Optional site block — present only on shared-per-language builds. */
	site?: LinksSiteBlock;
}

/** The empty result — a missing/unparseable/wrong-schema links.json renders
 *  every `<aff-link>` as an unresolved span, which is the designed fallback. */
function emptyLinks(): LoadedLinks {
	return { byCode: new Map(), bySlug: new Map(), site: undefined };
}

/**
 * Pure links.json → `LoadedLinks`. Split out of `loadLinksJson` so a non-Worker
 * host (static renderer, BigCloudy Node adapter) parses links.json with the
 * SAME filter the Worker uses instead of a hand-copied second version.
 *
 * Takes an ALREADY-PARSED body (the caller owns the I/O + JSON.parse). Callers
 * must wrap this in try/catch: a pathological non-iterable `assignments` throws,
 * and the correct response is `emptyLinks()` — exactly what the Worker does.
 */
export function parseLinksJson(body: unknown): LoadedLinks {
	const byCode = new Map<string, LinksAssignment>();
	const list: LinksAssignment[] = [];
	let site: LinksSiteBlock | undefined;
	const parsed = body as LinksJson | null | undefined;
	if (parsed?.schema_version !== '1.0') return emptyLinks();
	if (parsed.site && typeof parsed.site === 'object') site = parsed.site;
	for (const a of parsed.assignments ?? []) {
		if (!a || a.direction !== 'outgoing') continue;
		if (typeof a.code !== 'string' || typeof a.assignment_id !== 'string') continue;
		byCode.set(a.code, a);
		list.push(a);
	}
	return { byCode, bySlug: indexAssignmentsBySlug(list), site };
}

async function loadLinksJson(env: Env, host: string): Promise<LoadedLinks> {
	try {
		const url = new URL('/links.json', `https://${host}`);
		const res = await env.ASSETS.fetch(new Request(url.toString()));
		if (!res.ok) return emptyLinks();
		return parseLinksJson(await res.json());
	} catch {
		// Swallow — unresolved fallback is the right behaviour.
		return emptyLinks();
	}
}

/**
 * Resolve the shared `/go/{lang}/{brand}` token for the page at `pathname`, or
 * undefined to fall back to per-code rendering. Returns the token ONLY when the
 * site opted in (a `site` block) AND a matching slug assignment actually exists
 * — so a partial/legacy links.json never renders a dead shared link.
 *
 * Exported: a non-Worker host must compute `affOpts` the same way, or every
 * shared-per-language site silently falls back to per-code links.
 */
export function resolveSharedAffToken(links: LoadedLinks, pathname: string): string | undefined {
	if (!links.site) return undefined;
	const lang = pageLangFromPath(pathname, links.site);
	const token = sharedAffToken(lang, links.site);
	if (token && links.bySlug.has(token)) return token;
	return undefined;
}

/**
 * Replace every `<aff-link code="X">body</aff-link>` placeholder with either
 * a resolved anchor or an unresolved span. Pure function — no I/O — takes
 * the parsed assignment map. See the aff-link scope rule in
 * `docs/v3-site-source-format.md`.
 */
export function processAffLinks(
	html: string,
	assignments: Map<string, LinksAssignment>,
	opts?: { sharedToken?: string }
): string {
	return html.replace(AFF_LINK_REGEX, (match, attrSpanRaw: string, bodyRaw: string) => {
		const attrSpan = attrSpanRaw as string;
		const body = bodyRaw;
		const code = extractAffCode(attrSpan);
		// No parseable code → not a real placeholder; leave the markup untouched
		// (lockstep with the manager scanner, which also keys on `code`).
		if (code === null) return match;

		// Preserved presentational attrs carried from the original anchor
		// (class/id/style/…). The resolver OWNS href + data-aff; for `rel` the
		// assignment's value wins when set, else the preserved rel is used.
		const preserved = parsePreservedAffAttrs(attrSpan);
		const restAttrs = preserved.rest ? ` ${preserved.rest}` : '';

		// A per-code assignment explicitly configured as DIRECT (do-follow,
		// sellable — passes SEO juice, no /go hop) is a deliberate exception and
		// must NOT be collapsed into the shared sponsored-nofollow redirect. Let
		// those fall through to the per-code direct rendering below.
		const codeAssignment = assignments.get(code);
		const isDirectLink = codeAssignment?.mode === 'direct' && !!codeAssignment.target_url;

		// Shared per-language Pretty Link (operator 2026-07-17): when the caller
		// resolved a `{lang}/{brand}` token for this page, EVERY (non-direct) CTA
		// on the page renders that ONE shared /go link — keyed by the page's
		// language + brand, not the per-CTA code. The caller only sets sharedToken
		// when a matching slug assignment exists, so it always resolves. data-aff
		// keeps the code for per-placement click attribution; outgoing rel is the
		// required sponsored nofollow. (No sharedToken → per-code path below.)
		if (opts?.sharedToken && !isDirectLink) {
			const sharedClass = preserved.className
				? ` class="${escapeHtmlAttr(`${preserved.className} aff-link-unresolved`)}"`
				: ' class="aff-link-unresolved"';
			const rel = relAttr('sponsored nofollow');
			return `<a href="/go/${escapeHtmlAttr(opts.sharedToken)}"${sharedClass}${restAttrs}${rel} data-aff="${escapeHtmlAttr(code)}">${body}</a>`;
		}
		// Resolved/unresolved both need button styling. Header/CTA `<aff-link>` are
		// authored with NO class (composeHeader, game tiles), so a bare resolved
		// anchor would carry class="" and lose all button styling. Reuse the
		// `aff-link-unresolved` class — the shared stylesheet already renders it as
		// a proper button AND the `.game-card > .aff-link-unresolved` override keeps
		// whole-tile slots block/tile (not pills). When the author DID supply a
		// class (e.g. `cta`, `btn`), that already styles it; merge the marker so
		// neither styling source is lost. Context-aware via CSS, not code.
		const buttonClass = preserved.className
			? `${preserved.className} aff-link-unresolved`
			: 'aff-link-unresolved';
		const classAttr = ` class="${escapeHtmlAttr(buttonClass)}"`;
		const a = assignments.get(code);
		if (a && a.assignment_id) {
			// rel: assignment's rel wins; fall back to the preserved anchor rel.
			const rel = a.rel ? relAttr(a.rel) : relAttr(preserved.rel ?? undefined);
			// Direct mode: a plain do-follow outbound anchor to the REAL target —
			// no /go/ hop, no data-aff (not click-tracked). Passes SEO juice /
			// sellable. Falls back to redirect mode if target_url is missing.
			if (a.mode === 'direct' && a.target_url) {
				return `<a href="${escapeHtmlAttr(a.target_url)}"${classAttr}${restAttrs}${rel}>${body}</a>`;
			}
			// Redirect mode (default): tracked /go/{token} 302 hop. Prefer the
			// pretty `slug` so the cloaked URL reads `/go/log-in-17` not
			// `/go/asn_<uuid>`; fall back to assignment_id when no slug exists
			// (hand-authored assignments). The /go/:token resolver matches
			// slug-first then assignment_id, so either token resolves to the same
			// target. rel is low-value on the internal link but kept for consistency.
			const goToken = a.slug && SLUG_RE.test(a.slug) ? a.slug : a.assignment_id;
			return `<a href="/go/${escapeHtmlAttr(goToken)}"${classAttr}${restAttrs}${rel} data-aff="${escapeHtmlAttr(code)}">${body}</a>`;
		}
		// Unresolved: same button class as resolved (preserved class merged with
		// `aff-link-unresolved`) so neither the original styling nor the marker is lost.
		return `<a href="#"${classAttr}${restAttrs} data-aff="${escapeHtmlAttr(code)}" title="Unassigned affiliate slot">${body}</a>`;
	});
}

/**
 * Footer copyright year — kept permanently current at request time (#80).
 * The footer partial ships `<span data-year>2026</span>`; this rewrites the
 * span's body to `new Date().getFullYear()` on every HTML response so a site
 * built in 2025 still reads the correct year in 2030 with zero rebuild and no
 * client-side JS (works for no-JS visitors and crawlers).
 *
 * `data-year` is a custom attribute that does not appear in normal page copy,
 * so the match can't collide with content. The hardcoded year inside the span
 * is a safe fallback if this rewrite is ever bypassed. Exported for tests.
 */
const YEAR_TOKEN_REGEX = /(<span\s+data-year[^>]*>)[^<]*(<\/span>)/gi;

export function processYearToken(html: string, year?: number): string {
	// Optional fixed year: the static renderer + parity tests pass one for
	// deterministic output; the worker omits it (request-time current year).
	const y = String(year ?? new Date().getFullYear());
	return html.replace(YEAR_TOKEN_REGEX, (_m, open: string, close: string) => `${open}${y}${close}`);
}

/**
 * Inject the Cloudflare Web Analytics (RUM) beacon before `</body>` when a
 * RUM_SITE_TAG is bound (#102). Done at the worker's HTML rewrite layer — NOT
 * per-page at build time — so EVERY served HTML page (home, sub-pages, 404)
 * carries the beacon with zero per-page work, and the tag is build-substituted
 * via wrangler.jsonc [vars] so a single edit re-tags every page. Sites with no
 * tag (workers.dev-only previews) get no beacon, which is intended.
 *
 * The script string is byte-identical to the V2 builder's injectCfAnalytics
 * (packages/builder/src/steps/generate.ts) so RUM behaves the same across V2/V3.
 * Exported for tests.
 */
export function processCfBeacon(html: string, siteTag: string | undefined): string {
	if (!siteTag) return html;
	const script = `<script defer src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{"token": "${siteTag}"}'></script>`;
	if (html.includes('</body>')) return html.replace('</body>', `${script}\n</body>`);
	if (html.includes('</html>')) return html.replace('</html>', `${script}\n</html>`);
	return html + `\n${script}`;
}

/**
 * Inject a 0-specificity remediation stylesheet into every served HTML page so
 * ALREADY-DEPLOYED legacy sites pick up the v3 CSS quality fixes WITHOUT a
 * rebuild — the worker is re-seeded on every build (create_repo runtime
 * re-seed), so a worker-swap deploy alone propagates these. Mirrors the
 * `<aff-link>` button-class change (processAffLinks) on the CSS side.
 *
 * Every rule is wrapped in `:where(...)` so its specificity is ZERO — a newer
 * site whose own /partials/styles.html already styles these correctly (normal
 * specificity) ALWAYS wins, and only legacy sites missing the rule get the
 * fallback. Injected before `</head>` so the cascade order is: this fallback →
 * the site's own stylesheet (later + higher specificity) overrides it.
 *
 * Covers (v3-builder-fixes Phase E): aff-link CTA buttons (item from the held
 * fix), provider/payment logo light-plate (item 2), header space-between
 * (item 1) on the dedicated .header-inner (item 3). Exported for tests.
 */
const LEGACY_CSS_INJECT = `<style id="levr-legacy-fixes">
/* Header: brand-left / actions-right on the dedicated wrapper (items 1 + 3). */
:where(.site-header .header-inner){display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap}
/* Provider + payment logos AND compliance badges ride a white plate so dark /
   single-colour marks stay visible on dark surfaces (item 2). */
:where(.provider-logo,.payment-logo,.compliance-badge){background:#fff;padding:6px 10px;border-radius:8px;box-sizing:content-box;opacity:1}
/* Unresolved/resolved aff-link CTAs render as real buttons (held aff-link fix). */
:where(a.aff-link-unresolved){display:inline-block;padding:0.75rem 1.5rem;border-radius:var(--btn-radius,999px);background:var(--brand,#2bb46c);color:#fff;font-weight:700;text-decoration:none;line-height:1.2}
:where(a.aff-link-unresolved:hover){background:var(--brand-2,#1f8f54);text-decoration:none}
</style>`;

export function processCssInject(html: string): string {
	if (html.includes('</head>')) return html.replace('</head>', `${LEGACY_CSS_INJECT}\n</head>`);
	// No </head> (fragment / malformed) — prepend so the rules still load.
	return `${LEGACY_CSS_INJECT}\n${html}`;
}

/**
 * I/O source for SSI partials. `processIncludes` is I/O-agnostic so the SAME
 * transform serves both deploy targets: the worker passes an ASSETS-backed
 * loader (`assetsPartialLoader`), the static renderer (render-static.mjs)
 * passes an fs-backed one. Returns null when the partial doesn't exist.
 */
export type PartialLoader = (filePath: string) => Promise<string | null>;

export function assetsPartialLoader(env: Env, host: string): PartialLoader {
	return (filePath) => fetchPartial(env, host, filePath);
}

export async function processIncludes(
	html: string,
	envOrLoader: Env | PartialLoader,
	host?: string
): Promise<string> {
	// Back-compat overload: (html, env, host) — the worker + existing tests —
	// or (html, loadFile) for I/O-agnostic callers (static renderer).
	const loadFile: PartialLoader =
		typeof envOrLoader === 'function' ? envOrLoader : assetsPartialLoader(envOrLoader, host ?? '');
	const matches = [...html.matchAll(INCLUDE_REGEX)];
	if (matches.length === 0) return html;

	// Resolve all partials in parallel
	const resolved = await Promise.all(
		matches.map(async (m) => {
			let partial = await loadFile(m[1]);
			// Locale-suffixed chrome partial missing? Fall back to the default
			// (un-suffixed) so a build that didn't write header.<lang>.html still
			// ships a header rather than a chrome-less page.
			if (partial === null) {
				const fallback = defaultPartialFallback(m[1]);
				if (fallback) partial = await loadFile(fallback);
			}
			return { match: m[0], replacement: partial ?? `<!-- include failed: ${m[1]} -->` };
		})
	);

	// Splice in order (no nested includes — single pass). Use a REPLACER
	// FUNCTION, not the raw string: a string replacement makes JS interpret
	// $$, $&, $`, $', $n inside the partial HTML — a partial containing a
	// literal `$` (prices, inline scripts) would be silently corrupted.
	let out = html;
	for (const { match, replacement } of resolved) {
		out = out.replace(match, () => replacement);
	}
	return out;
}

/**
 * The assignment list `/go/{token}` resolves against, from an ALREADY-PARSED
 * links.json body. Deliberately LOOSER than `parseLinksJson`: it keeps every
 * truthy entry (no `code` / `direction` filter here) because
 * `indexAssignmentsBySlug` / `indexAssignmentsById` apply their own. A
 * hand-authored assignment with no `code` is therefore routable via `/go/`
 * even though it never renders as an `<aff-link>` — preserve that asymmetry.
 *
 * Exported so a non-Worker host reproduces `/go/` exactly.
 */
export function parseGoAssignments(body: unknown): LinksAssignment[] {
	const out: LinksAssignment[] = [];
	const parsed = body as LinksJson | null | undefined;
	if (parsed?.schema_version !== '1.0') return out;
	for (const a of parsed.assignments ?? []) {
		if (a) out.push(a);
	}
	return out;
}

/**
 * Slug-first `/go/{token}` resolution with assignment_id fallback — a pretty
 * `/go/:slug` wins over `/go/:assignment_id`, and existing `/go/<id>` links
 * keep resolving. Returns null when nothing resolves or the hit carries no
 * `target_url` (the caller 404s). Exported for the portable runtime + tests.
 */
export function resolveGoAssignment(
	assignments: LinksAssignment[],
	token: string
): LinksAssignment | null {
	const bySlug = indexAssignmentsBySlug(assignments);
	const byId = indexAssignmentsById(assignments);
	const hit = bySlug.get(token) ?? byId.get(token);
	if (!hit || !hit.target_url) return null;
	return hit;
}

/**
 * `/go/:id` — affiliate click redirect. Resolves the assignment_id against
 * links.json, appends any incoming query string (so UTMs etc. pass through),
 * logs the click (Analytics Engine if bound, console fallback otherwise),
 * and 302s to the target. Unknown id → 404.
 *
 * Exported for unit tests.
 */
export async function handleAffiliateRedirect(
	request: Request,
	env: Env,
	url: URL,
	assignmentId: string
): Promise<Response> {
	// loadLinksJson returns a map keyed on `code`. /go/:id needs an
	// assignment_id lookup, so re-index from the same source.
	let out: LinksAssignment[] = [];
	try {
		const linksUrl = new URL('/links.json', `https://${url.host}`);
		const linksRes = await env.ASSETS.fetch(new Request(linksUrl.toString()));
		if (linksRes.ok) {
			out = parseGoAssignments(await linksRes.json());
		}
	} catch {
		// Fall through — unknown id below.
	}
	// Slug-first resolution: a pretty /go/:slug wins over /go/:assignment_id.
	// Back-compat: existing /go/<id> links keep resolving via the id fallback.
	const hit = resolveGoAssignment(out, assignmentId);
	if (!hit || !hit.target_url) {
		return new Response('Not Found', {
			status: 404,
			headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-cache' },
		});
	}

	// Best-effort click log. Analytics Engine binding optional — sites
	// without it just lose telemetry, not the redirect.
	if (env.ANALYTICS && typeof env.ANALYTICS.writeDataPoint === 'function') {
		try {
			env.ANALYTICS.writeDataPoint({
				blobs: [hit.code, hit.assignment_id, url.host],
				indexes: [hit.code],
				doubles: [1],
			});
		} catch {
			// Telemetry failure must never block the redirect.
		}
	} else {
		console.log(`[aff-click] TODO_CF_ANALYTICS host=${url.host} code=${hit.code} id=${hit.assignment_id}`);
	}

	const target = buildRedirectTarget(hit.target_url, url.search);
	return new Response(null, {
		status: 302,
		headers: {
			location: target,
			'Cache-Control': 'no-store',
		},
	});
}

/**
 * Preview basic-auth gate. Mirrors the legacy V1 site-template (`levr:preview123`)
 * so V3 sites have the same workers.dev access policy: any `.workers.dev`
 * hostname requires Basic auth; custom domains bypass. Once authenticated,
 * a session cookie (`_lp=1`, 24h) skips the dialog on subsequent requests.
 *
 * Returns:
 *   - `Response` (401) if the request is to a workers.dev preview and is
 *     missing or has wrong credentials.
 *   - `{ needsSessionCookie: true }` if auth just succeeded — caller must
 *     attach `Set-Cookie: _lp=1` to the final response.
 *   - `{ needsSessionCookie: false }` if request is on a custom domain or
 *     already has a valid session cookie.
 */
function previewAuthGate(
	request: Request,
	url: URL
): Response | { needsSessionCookie: boolean } {
	const isPreview = url.hostname.endsWith('.workers.dev');
	if (!isPreview) return { needsSessionCookie: false };

	const cookie = request.headers.get('Cookie') || '';
	if (cookie.includes('_lp=1')) return { needsSessionCookie: false };

	const auth = request.headers.get('Authorization');
	if (!auth || !auth.startsWith('Basic ')) {
		return new Response('Authentication required', {
			status: 401,
			headers: {
				'WWW-Authenticate': 'Basic realm="Preview"',
				'X-Robots-Tag': 'noindex, nofollow',
			},
		});
	}
	let decoded = '';
	try {
		decoded = atob(auth.slice(6));
	} catch {
		// fall through — decoded stays empty, fails check below
	}
	if (decoded !== 'levr:preview123') {
		return new Response('Invalid credentials', {
			status: 401,
			headers: {
				'WWW-Authenticate': 'Basic realm="Preview"',
				'X-Robots-Tag': 'noindex, nofollow',
			},
		});
	}
	return { needsSessionCookie: true };
}

/**
 * Attach `Set-Cookie: _lp=1` (if needed) and `X-Robots-Tag: noindex,
 * nofollow` (always, on preview) to a response. No-op on custom domains.
 */
function applyPreviewHeaders(
	response: Response,
	url: URL,
	needsSessionCookie: boolean
): Response {
	const isPreview = url.hostname.endsWith('.workers.dev');
	if (!isPreview && !needsSessionCookie) return response;
	const headers = new Headers(response.headers);
	if (isPreview) headers.set('X-Robots-Tag', 'noindex, nofollow');
	if (needsSessionCookie) {
		headers.set('Set-Cookie', '_lp=1; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400');
	}
	return new Response(response.body, { status: response.status, headers });
}

export default {
	async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// Health + analytics endpoints run BEFORE the preview auth gate so
		// monitoring probes and pageview beacons work on auth-walled
		// workers.dev previews. Returned raw — no auth/cookie/X-Robots/security
		// header wrapping (the CMS reads /api/health directly).
		if (url.pathname === '/api/health') {
			return handleHealth();
		}
		if (url.pathname === '/api/analytics' && request.method === 'POST') {
			return handlePageview(request, env, url);
		}

		// Preview basic-auth gate — workers.dev only, custom domains bypass.
		const gate = previewAuthGate(request, url);
		if (gate instanceof Response) return gate;
		const needsSessionCookie = gate.needsSessionCookie;

		// `/go/:assignment_id` — affiliate click redirect. Intercepted
		// before the ASSETS fetch so it doesn't fall through to a 404.
		const goMatch = url.pathname.match(GO_PATH_REGEX);
		if (goMatch) {
			const redirect = await handleAffiliateRedirect(request, env, url, goMatch[1]);
			return applyPreviewHeaders(redirect, url, needsSessionCookie);
		}

		// `/favicon.ico` — browsers request it unconditionally; serve the
		// site's favicon.svg so there's no 404 and no binary .ico asset.
		if (url.pathname === '/favicon.ico') {
			const ico = await handleFaviconIco(env, url.host);
			return applyPreviewHeaders(withHeaders(ico, {}), url, needsSessionCookie);
		}

		const assetRes = await env.ASSETS.fetch(request);

		// Pass-through non-HTML (with cache + security headers)
		const contentType = assetRes.headers.get('content-type') || '';
		if (!contentType.includes('text/html')) {
			return applyPreviewHeaders(
				withHeaders(assetRes, cacheHeadersFor(url.pathname, contentType)),
				url,
				needsSessionCookie
			);
		}

		// Resolve aff-link placeholders against links.json. Fetched per
		// request — Cloudflare's edge cache on /links.json keeps this cheap
		// (operator pushes update assignments; cache busts on deploy).
		const links = await loadLinksJson(env, url.host);
		const linksAssignments = links.byCode;
		// Shared per-language Pretty Link token for THIS page (undefined on
		// legacy sites → per-code rendering, unchanged).
		const sharedToken = resolveSharedAffToken(links, url.pathname);
		const affOpts = sharedToken ? { sharedToken } : undefined;

		// 404 — try /404.html with same ESI processing
		if (assetRes.status === 404) {
			const notFoundUrl = new URL('/404.html', url);
			const notFoundRes = await env.ASSETS.fetch(new Request(notFoundUrl.toString()));
			if (notFoundRes.ok) {
				let html = await processIncludes(await notFoundRes.text(), env, url.host);
				html = processAffLinks(html, linksAssignments, affOpts);
				html = processYearToken(html);
				html = processCfBeacon(html, env.RUM_SITE_TAG);
				html = processCssInject(html);
				emitPageview(request, env, url, ctx);
				return applyPreviewHeaders(
					withHeaders(
						new Response(html, {
							status: 404,
							headers: { 'Content-Type': 'text/html; charset=utf-8' },
						}),
						cacheHeadersFor('/404.html', 'text/html')
					),
					url,
					needsSessionCookie
				);
			}
			return applyPreviewHeaders(
				withHeaders(
					new Response('Not Found', {
						status: 404,
						headers: { 'Content-Type': 'text/plain' },
					}),
					{ 'Cache-Control': 'no-cache' }
				),
				url,
				needsSessionCookie
			);
		}

		let html = await processIncludes(await assetRes.text(), env, url.host);
		html = processAffLinks(html, linksAssignments, affOpts);
		html = processYearToken(html);
		html = processCfBeacon(html, env.RUM_SITE_TAG);
		html = processCssInject(html);
		emitPageview(request, env, url, ctx);
		return applyPreviewHeaders(
			withHeaders(
				new Response(html, {
					status: assetRes.status,
					headers: { 'Content-Type': 'text/html; charset=utf-8' },
				}),
				cacheHeadersFor(url.pathname, 'text/html')
			),
			url,
			needsSessionCookie
		);
	},
};
