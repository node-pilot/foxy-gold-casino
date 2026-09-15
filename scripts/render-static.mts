#!/usr/bin/env tsx
/**
 * render-static — deterministic, zero-LLM static render of this site repo.
 *
 * Produces a fully resolved `dist/` from `public/` by running the SAME
 * transform chain the CF worker applies per request (same functions, imported
 * from src/index.ts — drift-proof by construction), in the same order:
 *   processIncludes → processAffLinks → processYearToken → processCfBeacon →
 *   processCssInject
 *
 * "Same functions" now extends to the INPUTS too: links.json parsing
 * (parseLinksJson / parseGoAssignments), the shared per-language token
 * (resolveSharedAffToken), /go/ token resolution (resolveGoAssignment) and
 * attribute escaping (escapeHtmlAttr) are all imported rather than
 * re-implemented. They used to be local copies, and the aff-link one had
 * silently diverged: this script never computed the shared token, so on a site
 * with a links.json `site` block it emitted per-code `/go/{slug}` where the
 * worker emits one shared `/go/{lang}/{brand}`. Since this script is the
 * PARITY ORACLE the BigCloudy runtime is diffed against, that divergence would
 * have been inherited by the new origin. Pinned by
 * src/__tests__/transform-exports-parity.test.ts, which runs this CLI for real
 * and byte-compares it against the worker.
 * plus a static-only 3-line year-updater script (crawlers/no-JS see the baked
 * year; JS keeps it current between pushes).
 *
 * `/go/` affiliate redirects (worker: 302 with query passthrough) are emitted
 * per --go-mode:
 *   stubs (DEFAULT) — `/go/<token>/index.html` meta-refresh + JS
 *     location.replace stubs. Works on any dumb static host (BigCloudy
 *     repo-pull hosting exposes no nginx config — plan Open Q2). Query
 *     passthrough via JS using the same `?`/`&` merge rule as
 *     buildRedirectTarget; no-JS visitors follow the meta refresh (no query
 *     passthrough — documented degradation).
 *   nginx — `dist/_levr/go-redirects.conf` exact-match 302 location blocks
 *     (+ `dist/_levr/site.conf`: 404 page, favicon alias, www 301 snippet)
 *     for origins where LEVR controls vhost includes.
 * Both slug AND assignment_id tokens are emitted per assignment, slug-first
 * on collision — matching the worker's dual resolution (slug shadows id).
 *
 * Usage:
 *   npx tsx scripts/render-static.mts [--out dist] [--go-mode stubs|nginx]
 *     [--rum-tag <cf_web_analytics_tag>] [--year <yyyy>] [--base public]
 *
 * Exit non-zero on any error — CI must fail loudly, never push a half dist/.
 */
import { mkdir, readdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { join, dirname, relative, sep } from 'node:path';
import {
	processIncludes,
	processAffLinks,
	processYearToken,
	processCfBeacon,
	processCssInject,
	buildRedirectTarget,
	escapeHtmlAttr,
	parseGoAssignments,
	parseLinksJson,
	resolveGoAssignment,
	resolveSharedAffToken,
	SLUG_RE,
	type LinksAssignment,
	type PartialLoader,
} from '../src/index';
import { V3_RUNTIME_VERSION } from '../src/version.gen';

// ---------------------------------------------------------------------------
// args
function arg(name: string, fallback?: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
		return process.argv[i + 1];
	}
	return fallback;
}

const BASE = arg('base', 'public')!;
const OUT = arg('out', 'dist')!;
const GO_MODE = arg('go-mode', 'stubs')!;
const RUM_TAG = arg('rum-tag');
const YEAR = arg('year') ? Number(arg('year')) : undefined;

if (GO_MODE !== 'stubs' && GO_MODE !== 'nginx') {
	console.error(`render-static: invalid --go-mode "${GO_MODE}" (stubs|nginx)`);
	process.exit(2);
}

// ---------------------------------------------------------------------------
// helpers

/** fs-backed PartialLoader: `/partials/header.html` → `<base>/partials/header.html`. */
function fsPartialLoader(baseDir: string): PartialLoader {
	return async (filePath: string) => {
		if (!filePath.startsWith('/')) return null;
		// Reject path traversal — include paths are site-authored but be strict.
		if (filePath.includes('..')) return null;
		try {
			return await readFile(join(baseDir, filePath.slice(1)), 'utf-8');
		} catch {
			return null;
		}
	};
}

/**
 * Read + JSON.parse public/links.json. Missing/unparseable → null, which both
 * parseLinksJson and parseGoAssignments degrade to empty — the worker's
 * fallback. A links.json that parses but is structurally pathological is left
 * to THROW out of the callers below: this script's contract is to exit non-zero
 * on any error (see the header), unlike the worker which must keep serving.
 */
async function loadLinksBody(baseDir: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(join(baseDir, 'links.json'), 'utf-8'));
	} catch {
		return null;
	}
}

/**
 * Token → target map for /go/ emission. The slug-shadows-id rule is NOT
 * re-implemented here — every candidate token is resolved through
 * `resolveGoAssignment`, the same function the worker's /go/ handler uses, so
 * there is exactly one definition of what a token resolves to. Candidates are
 * offered slugs-first purely to keep the emission order stable.
 */
function goTokenMap(all: LinksAssignment[]): Map<string, string> {
	const candidates: string[] = [];
	for (const a of all) {
		if (a.slug && SLUG_RE.test(a.slug)) candidates.push(a.slug);
	}
	for (const a of all) {
		if (a.assignment_id) candidates.push(a.assignment_id);
	}
	const map = new Map<string, string>();
	for (const token of candidates) {
		if (map.has(token)) continue;
		const hit = resolveGoAssignment(all, token);
		if (hit?.target_url) map.set(token, hit.target_url);
	}
	return map;
}

/**
 * The URL the worker serves this file at — which is what `pageLangFromPath`
 * must see. wrangler.jsonc sets `html_handling: "auto-trailing-slash"`, so CF
 * serves `public/sv.html` at `/sv` and `public/sv/index.html` at `/sv/`,
 * 307ing the `.html` form to the canonical one.
 *
 * Using the raw file path instead breaks ROOT-FILE locale homes: `sv.html`
 * would yield `/sv.html`, whose first segment is `sv.html`, which is not in
 * `languages` — so the page falls back to the DEFAULT language and renders an
 * English tracking link on the Swedish page. Directory-prefixed locales
 * (`sv/index.html`) happen to work either way, which is why the V3 builder's
 * own output never exposed this; IMPORTED sites carry the `xx.html` shape, and
 * re-hosting those is the entire point of the BigCloudy target.
 */
function servedPathname(rel: string): string {
	const posix = rel.split(sep).join('/');
	if (posix === 'index.html') return '/';
	if (posix.endsWith('/index.html')) return `/${posix.slice(0, -'index.html'.length)}`;
	if (posix.endsWith('.html')) return `/${posix.slice(0, -'.html'.length)}`;
	return `/${posix}`;
}

/** JS single-quoted string literal escape (also breaks </script>). */
function escapeJs(s: string): string {
	return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/<\//g, '<\\/');
}

/**
 * Static-only year updater. Injected AFTER the baked processYearToken pass so
 * pages untouched across a year boundary still show the current year for JS
 * visitors; crawlers/no-JS read the render-time year.
 */
const YEAR_UPDATER = `<script>for(var e=document.querySelectorAll('span[data-year]'),i=0;i<e.length;i++)e[i].textContent=new Date().getFullYear();</script>`;

function injectYearUpdater(html: string): string {
	if (html.includes('</body>')) return html.replace('</body>', `${YEAR_UPDATER}\n</body>`);
	return html + `\n${YEAR_UPDATER}`;
}

/**
 * /go/ HTML redirect stub. Query passthrough replicates buildRedirectTarget's
 * `?`/`&` merge rule at click time (JS); meta refresh is the no-JS fallback
 * (bare target, no passthrough). 200-not-302 is the accepted stub tradeoff.
 */
function goStubHtml(target: string): string {
	return `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="robots" content="noindex,nofollow">
<meta http-equiv="refresh" content="0;url=${escapeHtmlAttr(target)}">
<script>var t='${escapeJs(target)}',q=location.search;if(q&&q.length>1){t+=(t.indexOf('?')!==-1?'&':'?')+q.slice(1);}location.replace(t);</script>
</head><body><a href="${escapeHtmlAttr(target)}" rel="nofollow noopener">Continue</a></body></html>
`;
}

/** nginx exact-match 302 block with query passthrough (incl. the `?`/`&` edge). */
function goNginxBlock(token: string, target: string): string {
	// Tokens are slug ([a-z0-9-]) or assignment_id — safe in an nginx literal
	// location. Targets with an existing query need the merge branch (worker's
	// buildRedirectTarget appends with '&'); clean targets take $is_args$args.
	if (target.includes('?')) {
		return [
			`location = /go/${token} {`,
			`    if ($args) { return 302 "${target}&$args"; }`,
			`    return 302 "${target}";`,
			`}`,
		].join('\n');
	}
	return `location = /go/${token} { return 302 "${target}$is_args$args"; }`;
}

const SITE_CONF = `# LEVR static-site nginx snippet (generated by render-static v${V3_RUNTIME_VERSION})
# Include from the vhost server block when config control is available.
error_page 404 /404.html;
location = /favicon.ico { rewrite ^ /favicon.svg last; }
# www → apex 301 belongs in the www server block:
#   server { server_name www.$host; return 301 https://$host$request_uri; }
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
`;

// ---------------------------------------------------------------------------
// main
async function main(): Promise<void> {
	const baseDir = join(process.cwd(), BASE);
	const outDir = join(process.cwd(), OUT);

	await rm(outDir, { recursive: true, force: true });
	await mkdir(outDir, { recursive: true });

	const loadFile = fsPartialLoader(baseDir);
	const linksBody = await loadLinksBody(baseDir);
	const links = parseLinksJson(linksBody);
	// /go/ emission resolves against the LOOSER list (no `code` filter) — the
	// same asymmetry the worker has between rendering and redirecting.
	const goAssignments = parseGoAssignments(linksBody);

	// Walk public/** recursively.
	const files: string[] = [];
	async function walk(dir: string): Promise<void> {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const p = join(dir, entry.name);
			if (entry.isDirectory()) await walk(p);
			else if (entry.isFile()) files.push(p);
		}
	}
	await walk(baseDir);

	let htmlCount = 0;
	let assetCount = 0;
	for (const src of files) {
		const rel = relative(baseDir, src);
		const dst = join(outDir, rel);
		await mkdir(dirname(dst), { recursive: true });
		if (/\.html?$/i.test(src)) {
			// EXACT worker order (src/index.ts fetch handler): includes →
			// aff-links → year → beacon → css inject. Then the static-only
			// year updater.
			//
			// The shared per-language Pretty Link is keyed off the SERVED path,
			// so map the file to the URL the worker actually serves it at
			// (servedPathname). Omitting the shared token entirely is what made
			// the renderer diverge from the worker on every shared-per-language
			// site; using the raw file path instead of the served one is what
			// made it diverge on root-file locale homes.
			const sharedToken = resolveSharedAffToken(links, servedPathname(rel));
			let html = await readFile(src, 'utf-8');
			html = await processIncludes(html, loadFile);
			html = processAffLinks(html, links.byCode, sharedToken ? { sharedToken } : undefined);
			html = processYearToken(html, YEAR);
			html = processCfBeacon(html, RUM_TAG);
			html = processCssInject(html);
			html = injectYearUpdater(html);
			await writeFile(dst, html, 'utf-8');
			htmlCount++;
		} else {
			await copyFile(src, dst);
			assetCount++;
		}
	}

	// /go/ redirects.
	const tokens = goTokenMap(goAssignments);
	if (GO_MODE === 'stubs') {
		for (const [token, target] of tokens) {
			const stubDir = join(outDir, 'go', token);
			await mkdir(stubDir, { recursive: true });
			await writeFile(join(stubDir, 'index.html'), goStubHtml(target), 'utf-8');
		}
	} else {
		const levrDir = join(outDir, '_levr');
		await mkdir(levrDir, { recursive: true });
		const conf = [...tokens.entries()].map(([t, u]) => goNginxBlock(t, u)).join('\n');
		await writeFile(join(levrDir, 'go-redirects.conf'), conf + '\n', 'utf-8');
		await writeFile(join(levrDir, 'site.conf'), SITE_CONF, 'utf-8');
	}

	// Render metadata (debuggability + the CMS "which renderer version" probe —
	// the static analogue of the worker's /api/health version field).
	const levrDir = join(outDir, '_levr');
	await mkdir(levrDir, { recursive: true });
	await writeFile(
		join(levrDir, 'render-meta.json'),
		JSON.stringify(
			{
				renderer_version: V3_RUNTIME_VERSION,
				go_mode: GO_MODE,
				pages: htmlCount,
				assets: assetCount,
				go_tokens: tokens.size,
				rum: Boolean(RUM_TAG),
				rendered_at: new Date().toISOString(),
			},
			null,
			2
		) + '\n',
		'utf-8'
	);

	console.log(
		`render-static: ${htmlCount} pages, ${assetCount} assets, ${tokens.size} /go/ tokens (${GO_MODE}) → ${relative(process.cwd(), outDir) || outDir}${sep}`
	);
}

main().catch((e) => {
	console.error('render-static FAILED:', e);
	process.exit(1);
});

// goStubHtml re-expresses buildRedirectTarget's `?`/`&` merge rule in inline JS
// (it runs in the visitor's browser, not here), so nothing calls the real one.
// Importing it keeps a compile-time edge to the worker: rename or remove it and
// this script fails to typecheck rather than drifting silently.
//
// NOTE: this only became true when `scripts/**/*.mts` was added to tsconfig
// `include` — before that the comment claimed a guard that tsc never ran.
void buildRedirectTarget;
