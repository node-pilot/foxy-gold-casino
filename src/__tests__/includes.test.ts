import { describe, expect, it, vi } from 'vitest';
import { processIncludes, defaultPartialFallback, type Env } from '../index';

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

describe('processIncludes', () => {
	it('passes through HTML with no directives unchanged', async () => {
		const html = '<html><body><h1>Hello</h1></body></html>';
		const env = mockEnv({});
		expect(await processIncludes(html, env, 'example.com')).toBe(html);
	});

	it('splices in a single partial', async () => {
		const html = '<html><body><!-- #include file="/partials/header.html" --><main>x</main></body></html>';
		const env = mockEnv({ '/partials/header.html': '<header>NAV</header>' });
		const out = await processIncludes(html, env, 'example.com');
		expect(out).toBe('<html><body><header>NAV</header><main>x</main></body></html>');
	});

	it('splices a partial containing $ patterns VERBATIM ($&, $1 are not special) (#9)', async () => {
		// A string replacement would interpret $&, $`, $', $1 inside the partial —
		// e.g. a price "$5" or an inline script — silently corrupting the output.
		const html = '<body><!-- #include file="/partials/promo.html" --></body>';
		const partial = '<p>Bonus $&amp; deal: $500 or 100$ — regex $1 $` $\' safe</p>';
		const env = mockEnv({ '/partials/promo.html': partial });
		const out = await processIncludes(html, env, 'example.com');
		expect(out).toBe(`<body>${partial}</body>`);
	});

	it('splices multiple partials in document order', async () => {
		const html = [
			'<!-- #include file="/partials/header.html" -->',
			'<main>body</main>',
			'<!-- #include file="/partials/footer.html" -->',
		].join('\n');
		const env = mockEnv({
			'/partials/header.html': '<header>H</header>',
			'/partials/footer.html': '<footer>F</footer>',
		});
		const out = await processIncludes(html, env, 'example.com');
		expect(out).toBe('<header>H</header>\n<main>body</main>\n<footer>F</footer>');
	});

	it('emits a comment marker when a partial cannot be resolved', async () => {
		const html = '<!-- #include file="/partials/missing.html" -->';
		const env = mockEnv({});
		const out = await processIncludes(html, env, 'example.com');
		expect(out).toContain('include failed: /partials/missing.html');
		expect(out).not.toContain('#include');
	});

	it('rejects relative paths (must start with /)', async () => {
		const html = '<!-- #include file="partials/header.html" -->';
		const env = mockEnv({ '/partials/header.html': '<header>X</header>' });
		const out = await processIncludes(html, env, 'example.com');
		expect(out).toContain('include failed: partials/header.html');
	});

	it('splices a locale-suffixed partial when it exists', async () => {
		const html = '<!-- #include file="/partials/header.sv.html" -->';
		const env = mockEnv({
			'/partials/header.sv.html': '<header>HEM</header>',
			'/partials/header.html': '<header>HOME</header>',
		});
		const out = await processIncludes(html, env, 'example.com');
		expect(out).toBe('<header>HEM</header>');
	});

	it('falls back to the default partial when the locale partial is missing', async () => {
		const html = '<!-- #include file="/partials/header.sv.html" -->';
		// Only the default header.html exists — sv was never written.
		const env = mockEnv({ '/partials/header.html': '<header>HOME</header>' });
		const out = await processIncludes(html, env, 'example.com');
		expect(out).toBe('<header>HOME</header>');
		expect(out).not.toContain('include failed');
	});

	it('emits a failure marker when BOTH locale and default partials are missing', async () => {
		const html = '<!-- #include file="/partials/footer.sv.html" -->';
		const env = mockEnv({});
		const out = await processIncludes(html, env, 'example.com');
		expect(out).toContain('include failed: /partials/footer.sv.html');
	});

	it('does not recurse into nested includes (single-pass)', async () => {
		// header partial itself contains an include directive — should NOT be expanded.
		const html = '<!-- #include file="/partials/header.html" -->';
		const env = mockEnv({
			'/partials/header.html': '<header><!-- #include file="/partials/nav.html" --></header>',
			'/partials/nav.html': '<nav>N</nav>',
		});
		const out = await processIncludes(html, env, 'example.com');
		expect(out).toBe('<header><!-- #include file="/partials/nav.html" --></header>');
	});
});

describe('defaultPartialFallback', () => {
	it('maps a locale-suffixed chrome partial to its un-suffixed default', () => {
		expect(defaultPartialFallback('/partials/header.sv.html')).toBe('/partials/header.html');
		expect(defaultPartialFallback('/partials/footer.nl-be.html')).toBe('/partials/footer.html');
	});

	it('returns null for an un-suffixed partial (no fallback)', () => {
		expect(defaultPartialFallback('/partials/header.html')).toBeNull();
		expect(defaultPartialFallback('/partials/styles.html')).toBeNull();
	});

	it('returns null for non-chrome partials (styles is locale-agnostic)', () => {
		expect(defaultPartialFallback('/partials/styles.sv.html')).toBeNull();
		expect(defaultPartialFallback('/partials/payment-row.html')).toBeNull();
	});
});
