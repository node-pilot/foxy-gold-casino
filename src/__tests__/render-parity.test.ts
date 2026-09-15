import { describe, expect, it, vi } from 'vitest';
import {
	processIncludes,
	processAffLinks,
	processYearToken,
	processCfBeacon,
	processCssInject,
	type Env,
	type PartialLoader,
	type LinksAssignment,
} from '../index';

/**
 * Static-render parity (static-links refactor Phase 0, step 3).
 *
 * The static renderer (scripts/render-static.mts) must produce byte-identical
 * HTML to the worker's request-time transform chain. Both run the SAME
 * exported functions in the SAME order — the only degree of freedom is the
 * I/O source for SSI partials (worker: env.ASSETS; renderer: fs). So parity
 * reduces to: for identical partial content, the loader-style call path
 * (what the renderer uses) equals the (env, host) call path (what the worker
 * uses), across the full chain with fixed year/beacon inputs.
 */

const FILES: Record<string, string> = {
	'/partials/header.html': '<header><nav><aff-link code="hdr-cta">Join</aff-link></nav></header>',
	'/partials/footer.html': '<footer><span data-year>2020</span></footer>',
	'/partials/header.sv.html': '<header>SV</header>',
};

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
					headers: { 'Content-Type': 'text/html; charset=utf-8' },
				});
			}),
		} as unknown as Fetcher,
	};
}

/** The renderer's loader shape over the same virtual files. */
function mapLoader(files: Record<string, string>): PartialLoader {
	return async (filePath: string) => files[filePath] ?? null;
}

const ASSIGNMENTS = new Map<string, LinksAssignment>([
	[
		'hdr-cta',
		{
			assignment_id: 'asn_parity1',
			code: 'hdr-cta',
			direction: 'outgoing',
			target_url: 'https://partner.example/offer',
			slug: 'join-now',
			mode: 'redirect',
			rel: 'sponsored',
		},
	],
	[
		'body-direct',
		{
			assignment_id: 'asn_parity2',
			code: 'body-direct',
			direction: 'outgoing',
			target_url: 'https://partner.example/direct?src=x',
			mode: 'direct',
		},
	],
]);

const PAGE = `<!doctype html>
<html><head><title>P</title></head><body>
<!-- #include file="/partials/header.html" -->
<!-- #include file="/partials/header.de.html" -->
<main>
  <aff-link code="body-direct" class="btn">Direct</aff-link>
  <aff-link code="nope">Unassigned</aff-link>
</main>
<!-- #include file="/partials/footer.html" -->
</body></html>`;

async function workerChain(html: string): Promise<string> {
	// Exactly src/index.ts fetch(): includes(env,host) → aff → year → beacon → css.
	let out = await processIncludes(html, mockEnv(FILES), 'example.com');
	out = processAffLinks(out, ASSIGNMENTS);
	out = processYearToken(out, 2026);
	out = processCfBeacon(out, 'tag_abc123');
	out = processCssInject(out);
	return out;
}

async function rendererChain(html: string): Promise<string> {
	// Exactly scripts/render-static.mts: includes(loader) → same tail.
	let out = await processIncludes(html, mapLoader(FILES));
	out = processAffLinks(out, ASSIGNMENTS);
	out = processYearToken(out, 2026);
	out = processCfBeacon(out, 'tag_abc123');
	out = processCssInject(out);
	return out;
}

describe('static render parity with the worker transform chain', () => {
	it('produces byte-identical output across the full chain', async () => {
		const worker = await workerChain(PAGE);
		const renderer = await rendererChain(PAGE);
		expect(renderer).toBe(worker);
	});

	it('resolves the expected transforms (sanity on the shared output)', async () => {
		const out = await rendererChain(PAGE);
		// Includes resolved, incl. the locale fallback path (header.de.html →
		// header.html) — so BOTH header instances resolve the hdr-cta slot.
		expect(out).not.toContain('#include');
		expect((out.match(/href="\/go\/join-now"/g) ?? []).length).toBe(2);
		// Direct mode + unresolved slot.
		expect(out).toContain('href="https://partner.example/direct?src=x"');
		expect(out).toContain('title="Unassigned affiliate slot"');
		expect(out).not.toMatch(/<aff-link\s+[^>]*>/);
		// Fixed year baked, beacon + css inject present exactly once.
		expect(out).toContain('<span data-year>2026</span>');
		expect((out.match(/beacon\.min\.js/g) ?? []).length).toBe(1);
		expect((out.match(/levr-legacy-fixes/g) ?? []).length).toBe(1);
	});

	it('loader-style and (env, host)-style includes agree on missing-partial fallback text', async () => {
		const html = '<!-- #include file="/partials/gone.html" -->';
		const viaEnv = await processIncludes(html, mockEnv(FILES), 'example.com');
		const viaLoader = await processIncludes(html, mapLoader(FILES));
		expect(viaLoader).toBe(viaEnv);
		expect(viaLoader).toContain('include failed');
	});
});
