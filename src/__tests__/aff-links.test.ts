import { describe, expect, it } from 'vitest';
import {
	extractAffCode,
	GO_PATH_REGEX,
	indexAssignmentsBySlug,
	pageLangFromPath,
	processAffLinks,
	relAttr,
	sharedAffToken,
	SLUG_RE,
} from '../index';

describe('processAffLinks', () => {
	it('passes through HTML with no aff-link placeholders unchanged', () => {
		const html = '<html><body><h1>Hello</h1><a href="/games">Games</a></body></html>';
		expect(processAffLinks(html, new Map())).toBe(html);
	});

	it('substitutes a resolved aff-link with an anchor pointing at /go/{assignment_id}', () => {
		const html = '<aff-link code="primary-cta">Play now</aff-link>';
		const map = new Map([
			[
				'primary-cta',
				{ assignment_id: 'asg_abc123', code: 'primary-cta', direction: 'outgoing' as const, target_url: 'https://x' },
			],
		]);
		const out = processAffLinks(html, map);
		expect(out).toBe('<a href="/go/asg_abc123" class="aff-link-unresolved" data-aff="primary-cta">Play now</a>');
	});

	it('emits /go/{slug} (pretty code) when the assignment carries a slug', () => {
		// The bug fix: cloaked URLs must use the human/pretty slug
		// (e.g. log-in-17), not the raw asn_<uuid> assignment_id.
		const html = '<aff-link code="log-in-17">Log in</aff-link>';
		const map = new Map([
			[
				'log-in-17',
				{
					assignment_id: 'asn_308c7997-9478-4afc-867a-ce2e866a9630',
					code: 'log-in-17',
					direction: 'outgoing' as const,
					target_url: 'https://x',
					slug: 'log-in-17',
				},
			],
		]);
		const out = processAffLinks(html, map);
		expect(out).toBe('<a href="/go/log-in-17" class="aff-link-unresolved" data-aff="log-in-17">Log in</a>');
		expect(out).not.toContain('asn_');
	});

	it('emits a multi-segment /go/{lang}/{brand} path when the slug contains a slash', () => {
		// Standard-format CTA URL request: every CTA resolves to /go/en/starzino.
		const html = '<aff-link code="hero-cta">Play now</aff-link>';
		const map = new Map([
			[
				'hero-cta',
				{
					assignment_id: 'asn_abc',
					code: 'hero-cta',
					direction: 'outgoing' as const,
					target_url: 'https://x',
					slug: 'en/starzino',
				},
			],
		]);
		const out = processAffLinks(html, map);
		expect(out).toBe('<a href="/go/en/starzino" class="aff-link-unresolved" data-aff="hero-cta">Play now</a>');
	});

	it('falls back to /go/{assignment_id} when the assignment has no slug (back-compat)', () => {
		const html = '<aff-link code="primary-cta">Play now</aff-link>';
		const map = new Map([
			['primary-cta', { assignment_id: 'asn_legacy', code: 'primary-cta', direction: 'outgoing' as const, target_url: 'https://x' }],
		]);
		const out = processAffLinks(html, map);
		expect(out).toBe('<a href="/go/asn_legacy" class="aff-link-unresolved" data-aff="primary-cta">Play now</a>');
	});

	it('ignores a malformed slug and falls back to assignment_id (no injection via slug)', () => {
		const html = '<aff-link code="cta">Play</aff-link>';
		const map = new Map([
			['cta', { assignment_id: 'asn_safe', code: 'cta', direction: 'outgoing' as const, target_url: 'https://x', slug: 'Bad Slug"' } as never],
		]);
		const out = processAffLinks(html, map);
		expect(out).toBe('<a href="/go/asn_safe" class="aff-link-unresolved" data-aff="cta">Play</a>');
	});

	it('renders an unresolved aff-link as a clickable anchor with data-aff + title', () => {
		const html = '<aff-link code="primary-cta">Play now</aff-link>';
		const out = processAffLinks(html, new Map());
		expect(out).toContain('<a href="#" class="aff-link-unresolved"');
		expect(out).toContain('data-aff="primary-cta"');
		expect(out).toContain('title="Unassigned affiliate slot"');
		expect(out).toContain('Play now');
		expect(out).not.toContain('<span');
	});

	it('resolves when code is NOT the first attribute (lockstep with the manager scanner)', () => {
		// The manager-side scanner matches `code` in any attribute position;
		// the runtime must too, or a slot the manager shows as assigned would
		// silently render inert. See AFF_LINK_REGEX note in index.ts.
		// Preserved presentational attrs (class/data-*) now ride onto the <a>.
		const html = '<aff-link class="btn" data-x="1" code="primary-cta">Play now</aff-link>';
		const map = new Map([
			['primary-cta', { assignment_id: 'asg_abc123', code: 'primary-cta', direction: 'outgoing' as const, target_url: 'https://x' }],
		]);
		const out = processAffLinks(html, map);
		expect(out).toBe('<a href="/go/asg_abc123" class="btn aff-link-unresolved" data-x="1" data-aff="primary-cta">Play now</a>');
	});

	it('preserves inline HTML inside the CTA body when resolving', () => {
		const html = '<aff-link code="primary-cta"><span class="icon">★</span> Play</aff-link>';
		const map = new Map([
			['primary-cta', { assignment_id: 'asg_1', code: 'primary-cta', direction: 'outgoing' as const }],
		]);
		const out = processAffLinks(html, map);
		expect(out).toBe('<a href="/go/asg_1" class="aff-link-unresolved" data-aff="primary-cta"><span class="icon">★</span> Play</a>');
	});

	it('preserves inline HTML inside the CTA body when unresolved', () => {
		const html = '<aff-link code="primary-cta"><span class="icon">★</span> Play</aff-link>';
		const out = processAffLinks(html, new Map());
		expect(out).toContain('<span class="icon">★</span> Play');
		expect(out).toContain('class="aff-link-unresolved"');
	});

	it('resolves multiple aff-links in document order', () => {
		const html = [
			'<aff-link code="primary-cta">A</aff-link>',
			'<aff-link code="footer-banner">B</aff-link>',
			'<aff-link code="missing">C</aff-link>',
		].join('\n');
		const map = new Map([
			['primary-cta', { assignment_id: 'asg_a', code: 'primary-cta', direction: 'outgoing' as const }],
			['footer-banner', { assignment_id: 'asg_b', code: 'footer-banner', direction: 'outgoing' as const }],
		]);
		const out = processAffLinks(html, map);
		expect(out.split('\n')).toEqual([
			'<a href="/go/asg_a" class="aff-link-unresolved" data-aff="primary-cta">A</a>',
			'<a href="/go/asg_b" class="aff-link-unresolved" data-aff="footer-banner">B</a>',
			'<a href="#" class="aff-link-unresolved" data-aff="missing" title="Unassigned affiliate slot">C</a>',
		]);
	});

	it('whole-tile aff-link renders exactly ONE anchor wrapping the tile content', () => {
		// Whole-tile-clickable pattern: one <aff-link code="game-tile"> wraps the
		// entire tile inner content (img + visually-hidden label + overlay). The
		// runtime must turn it into exactly ONE <a> with NO nested anchors.
		const html =
			'<article class="game-card"><span class="badge">HOT</span>' +
			'<aff-link code="game-tile">' +
			'<img src="/assets/game/x.webp" alt="Power of Tiger by Smartsoft Gaming">' +
			'<span class="visually-hidden">Power of Tiger by Smartsoft Gaming</span>' +
			'<span class="game-overlay"><span class="provider">Smartsoft Gaming</span><span class="play-btn">Play</span></span>' +
			'</aff-link></article>';
		const out = processAffLinks(html, new Map());
		// Exactly one opening + one closing anchor.
		expect((out.match(/<a\b/g) ?? []).length).toBe(1);
		expect((out.match(/<\/a>/g) ?? []).length).toBe(1);
		// The single anchor is the unresolved game-tile placeholder.
		expect(out).toContain('<a href="#" class="aff-link-unresolved" data-aff="game-tile"');
		// Tile inner content is preserved inside the anchor.
		expect(out).toContain('<span class="visually-hidden">Power of Tiger by Smartsoft Gaming</span>');
		expect(out).toContain('class="play-btn"');
		// No leftover <aff-link> tags.
		expect(out).not.toContain('<aff-link');
	});

	it('whole-tile aff-link resolves to a single /go/ anchor when assigned', () => {
		const html =
			'<article class="game-card"><aff-link code="game-tile">' +
			'<img src="/assets/game/x.webp" alt="x"><span class="play-btn">Play</span>' +
			'</aff-link></article>';
		const map = new Map([
			['game-tile', { assignment_id: 'asg_tile', code: 'game-tile', direction: 'outgoing' as const, target_url: 'https://aff.example/?id=1' }],
		]);
		const out = processAffLinks(html, map);
		expect((out.match(/<a\b/g) ?? []).length).toBe(1);
		// Resolved whole-tile slot carries `aff-link-unresolved`; the
		// `.game-card > .aff-link-unresolved` CSS override keeps it a block tile.
		expect(out).toContain('<a href="/go/asg_tile" class="aff-link-unresolved" data-aff="game-tile">');
	});

	it('escapes ampersands in the assignment_id when resolved', () => {
		// assignment_id is usually a UUID-ish slug, but defence-in-depth: it's
		// reflected into an href and must not enable attribute-injection.
		const html = '<aff-link code="primary-cta">x</aff-link>';
		const map = new Map([
			['primary-cta', { assignment_id: 'asg&"<>', code: 'primary-cta', direction: 'outgoing' as const }],
		]);
		const out = processAffLinks(html, map);
		expect(out).toContain('href="/go/asg&amp;&quot;&lt;&gt;"');
		expect(out).not.toContain('href="/go/asg&"<>"');
	});

	// ── Mode + rel (Direct-mode + rel toggle) ───────────────────────────────────

	it('redirect mode is the default when mode is absent (unchanged behaviour)', () => {
		const html = '<aff-link code="primary-cta">Play now</aff-link>';
		const map = new Map([
			['primary-cta', { assignment_id: 'asg_1', code: 'primary-cta', direction: 'outgoing' as const, target_url: 'https://aff.example/?id=1' }],
		]);
		const out = processAffLinks(html, map);
		expect(out).toBe('<a href="/go/asg_1" class="aff-link-unresolved" data-aff="primary-cta">Play now</a>');
	});

	it('redirect mode explicitly set renders the /go/ hop (same as default)', () => {
		const html = '<aff-link code="primary-cta">Play now</aff-link>';
		const map = new Map([
			['primary-cta', { assignment_id: 'asg_1', code: 'primary-cta', direction: 'outgoing' as const, target_url: 'https://aff.example/?id=1', mode: 'redirect' as const }],
		]);
		const out = processAffLinks(html, map);
		expect(out).toBe('<a href="/go/asg_1" class="aff-link-unresolved" data-aff="primary-cta">Play now</a>');
	});

	it('direct mode renders the REAL target URL with no /go/ hop and no data-aff', () => {
		const html = '<aff-link code="primary-cta">Play now</aff-link>';
		const map = new Map([
			['primary-cta', { assignment_id: 'asg_1', code: 'primary-cta', direction: 'outgoing' as const, target_url: 'https://aff.example/?id=1', mode: 'direct' as const }],
		]);
		const out = processAffLinks(html, map);
		expect(out).toBe('<a href="https://aff.example/?id=1" class="aff-link-unresolved">Play now</a>');
		expect(out).not.toContain('/go/');
		expect(out).not.toContain('data-aff');
	});

	it('direct mode falls back to redirect when target_url is missing', () => {
		const html = '<aff-link code="primary-cta">Play now</aff-link>';
		const map = new Map([
			['primary-cta', { assignment_id: 'asg_1', code: 'primary-cta', direction: 'outgoing' as const, mode: 'direct' as const }],
		]);
		const out = processAffLinks(html, map);
		expect(out).toBe('<a href="/go/asg_1" class="aff-link-unresolved" data-aff="primary-cta">Play now</a>');
	});

	it('redirect mode includes a rel attribute when set', () => {
		const html = '<aff-link code="primary-cta">Play now</aff-link>';
		const map = new Map([
			['primary-cta', { assignment_id: 'asg_1', code: 'primary-cta', direction: 'outgoing' as const, target_url: 'https://x', rel: 'sponsored nofollow' }],
		]);
		const out = processAffLinks(html, map);
		expect(out).toBe('<a href="/go/asg_1" class="aff-link-unresolved" rel="sponsored nofollow" data-aff="primary-cta">Play now</a>');
	});

	it('direct mode applies the rel attribute on the real-target anchor', () => {
		const html = '<aff-link code="primary-cta">Play now</aff-link>';
		const map = new Map([
			['primary-cta', { assignment_id: 'asg_1', code: 'primary-cta', direction: 'outgoing' as const, target_url: 'https://aff.example/?id=1', mode: 'direct' as const, rel: 'nofollow' }],
		]);
		const out = processAffLinks(html, map);
		expect(out).toBe('<a href="https://aff.example/?id=1" class="aff-link-unresolved" rel="nofollow">Play now</a>');
	});

	it('escapes ampersands in the direct-mode target_url', () => {
		const html = '<aff-link code="primary-cta">x</aff-link>';
		const map = new Map([
			['primary-cta', { assignment_id: 'asg_1', code: 'primary-cta', direction: 'outgoing' as const, target_url: 'https://aff.example/?a=1&b=2', mode: 'direct' as const }],
		]);
		const out = processAffLinks(html, map);
		expect(out).toContain('href="https://aff.example/?a=1&amp;b=2"');
	});
});

// ── Preserved presentational attrs (fix/aff-convert-preserve-styling) ───────────
describe('processAffLinks — preserves placeholder presentational attrs', () => {
	it('redirect branch: carries class + id onto the /go/ anchor', () => {
		const html = '<aff-link code="cta" class="cta-button" id="x">Claim</aff-link>';
		const map = new Map([
			['cta', { assignment_id: 'asg_1', code: 'cta', direction: 'outgoing' as const, target_url: 'https://aff.example/?id=1' }],
		]);
		const out = processAffLinks(html, map);
		expect(out).toBe('<a href="/go/asg_1" class="cta-button aff-link-unresolved" id="x" data-aff="cta">Claim</a>');
	});

	it('direct branch: carries preserved attrs onto the real-target anchor', () => {
		const html = '<aff-link code="cta" class="cta-button" id="x">Claim</aff-link>';
		const map = new Map([
			['cta', { assignment_id: 'asg_1', code: 'cta', direction: 'outgoing' as const, target_url: 'https://aff.example/?id=1', mode: 'direct' as const }],
		]);
		const out = processAffLinks(html, map);
		expect(out).toBe('<a href="https://aff.example/?id=1" class="cta-button aff-link-unresolved" id="x">Claim</a>');
		expect(out).not.toContain('data-aff');
	});

	it('unresolved branch: MERGES preserved class with aff-link-unresolved', () => {
		const html = '<aff-link code="cta" class="cta-button" id="x">Claim</aff-link>';
		const out = processAffLinks(html, new Map());
		expect(out).toBe(
			'<a href="#" class="cta-button aff-link-unresolved" id="x" data-aff="cta" title="Unassigned affiliate slot">Claim</a>',
		);
	});

	it('rel: assignment rel WINS over a preserved rel', () => {
		const html = '<aff-link code="cta" rel="noopener">Claim</aff-link>';
		const map = new Map([
			['cta', { assignment_id: 'asg_1', code: 'cta', direction: 'outgoing' as const, target_url: 'https://x', rel: 'sponsored nofollow' }],
		]);
		const out = processAffLinks(html, map);
		expect(out).toBe('<a href="/go/asg_1" class="aff-link-unresolved" rel="sponsored nofollow" data-aff="cta">Claim</a>');
	});

	it('rel: preserved rel is used when the assignment has none (validated by relAttr)', () => {
		const html = '<aff-link code="cta" rel="nofollow">Claim</aff-link>';
		const map = new Map([
			['cta', { assignment_id: 'asg_1', code: 'cta', direction: 'outgoing' as const, target_url: 'https://x' }],
		]);
		const out = processAffLinks(html, map);
		expect(out).toBe('<a href="/go/asg_1" class="aff-link-unresolved" rel="nofollow" data-aff="cta">Claim</a>');
	});

	it('escapes preserved attribute values (no attribute injection)', () => {
		const html = '<aff-link code="cta" title=\'a"b\'>Claim</aff-link>';
		const out = processAffLinks(html, new Map());
		expect(out).toContain('title="a&quot;b"');
		expect(out).not.toContain('title="a"b"');
	});
});

describe('shared per-language Pretty Link — one /go/{lang}/{brand} per language', () => {
	describe('pageLangFromPath', () => {
		const site = { brand: 'starzinocas', default_lang: 'en', languages: ['en', 'nl', 'sv'] };
		it('returns the default language for an un-prefixed (default-locale) path', () => {
			expect(pageLangFromPath('/', site)).toBe('en');
			expect(pageLangFromPath('/games.html', site)).toBe('en');
		});
		it('reads a non-default locale from the first path segment', () => {
			expect(pageLangFromPath('/nl/', site)).toBe('nl');
			expect(pageLangFromPath('/sv/spel.html', site)).toBe('sv');
		});
		it('treats an unknown first segment as the default language', () => {
			expect(pageLangFromPath('/bonuses.html', site)).toBe('en');
			expect(pageLangFromPath('/de/', site)).toBe('en'); // de not in languages
		});
		it('falls back to en when the site block has no language info', () => {
			expect(pageLangFromPath('/nl/', undefined)).toBe('en');
			expect(pageLangFromPath('/nl/', {})).toBe('en');
		});
		it('reads regional ll-rr locales from the first segment (AU/CA variants)', () => {
			const regional = { brand: 'starzinocas', default_lang: 'en-au', languages: ['en-au', 'en-ca'] };
			expect(pageLangFromPath('/', regional)).toBe('en-au');
			expect(pageLangFromPath('/en-ca/', regional)).toBe('en-ca');
			expect(pageLangFromPath('/en-ca/games.html', regional)).toBe('en-ca');
			// Unknown segment (bare 'en' is NOT a build language here) → default.
			expect(pageLangFromPath('/en/', regional)).toBe('en-au');
		});
	});

	describe('sharedAffToken', () => {
		it('builds {lang}/{brand} and validates it against SLUG_RE', () => {
			expect(sharedAffToken('en', { brand: 'starzinocas' })).toBe('en/starzinocas');
			expect(sharedAffToken('nl', { brand: 'starzinocas' })).toBe('nl/starzinocas');
		});
		it('keeps the hyphen in a regional ll-rr lang (en-au/{brand})', () => {
			expect(sharedAffToken('en-au', { brand: 'starzinocas' })).toBe('en-au/starzinocas');
		});
		it('slugifies a messy brand/lang', () => {
			expect(sharedAffToken('EN', { brand: 'Starzino Cas!' })).toBe('en/starzino-cas');
		});
		it('returns null when the brand is missing (caller falls back to per-code)', () => {
			expect(sharedAffToken('en', {})).toBeNull();
			expect(sharedAffToken('en', undefined)).toBeNull();
		});
	});

	describe('processAffLinks with a sharedToken', () => {
		const map = new Map([
			['home-hero-cta', { assignment_id: 'asg_1', code: 'home-hero-cta', direction: 'outgoing' as const, target_url: 'https://aff/en', slug: 'en/starzinocas' }],
		]);
		it('renders the ONE shared /go/{lang}/{brand} for every CTA, keeping data-aff for attribution', () => {
			const html = '<aff-link code="home-hero-cta">Play</aff-link> ... <aff-link code="footer-cta">Join</aff-link>';
			const out = processAffLinks(html, map, { sharedToken: 'en/starzinocas' });
			// BOTH distinct-code CTAs collapse to the same shared link.
			expect(out).toContain('<a href="/go/en/starzinocas"');
			expect((out.match(/href="\/go\/en\/starzinocas"/g) || []).length).toBe(2);
			// Per-placement code is preserved for click attribution.
			expect(out).toContain('data-aff="home-hero-cta"');
			expect(out).toContain('data-aff="footer-cta"');
			// Outgoing affiliate rel disclosure is present.
			expect(out).toContain('rel="sponsored nofollow"');
		});
		it('resolves a CTA that has NO per-code assignment (shared link is code-independent)', () => {
			const html = '<aff-link code="never-assigned">Bonus</aff-link>';
			const out = processAffLinks(html, new Map(), { sharedToken: 'nl/starzinocas' });
			expect(out).toContain('<a href="/go/nl/starzinocas"');
			expect(out).toContain('data-aff="never-assigned"');
		});
		it('preserves an author-supplied class alongside the button marker', () => {
			const html = '<aff-link code="c" class="btn primary">Go</aff-link>';
			const out = processAffLinks(html, new Map(), { sharedToken: 'en/brand' });
			expect(out).toContain('class="btn primary aff-link-unresolved"');
		});
		it('WITHOUT a sharedToken renders the per-code path unchanged (legacy sites)', () => {
			const html = '<aff-link code="home-hero-cta">Play</aff-link>';
			const out = processAffLinks(html, map); // no opts
			// Legacy path uses the per-assignment slug, not a shared token.
			expect(out).toBe('<a href="/go/en/starzinocas" class="aff-link-unresolved" data-aff="home-hero-cta">Play</a>');
		});
		it('does NOT collapse a DIRECT (do-follow) assignment into the shared hop (#37)', () => {
			// A deliberately direct/sellable link must keep its real do-follow target
			// even on a shared-model site — not become the sponsored-nofollow /go hop.
			const directMap = new Map([
				['seo-partner', { assignment_id: 'asg_d', code: 'seo-partner', direction: 'outgoing' as const, target_url: 'https://partner.example/', mode: 'direct' as const, slug: 'en/starzinocas' }],
			]);
			const html = '<aff-link code="seo-partner">Partner</aff-link>';
			const out = processAffLinks(html, directMap, { sharedToken: 'en/starzinocas' });
			expect(out).toBe('<a href="https://partner.example/" class="aff-link-unresolved">Partner</a>');
			expect(out).not.toContain('/go/');
			expect(out).not.toContain('data-aff');
		});
	});
});

describe('extractAffCode', () => {
	it('finds code in any position, both quote styles', () => {
		expect(extractAffCode('code="x"')).toBe('x');
		expect(extractAffCode("class='btn' code='y'")).toBe('y');
		expect(extractAffCode('class="btn"')).toBe(null);
	});
});

describe('relAttr', () => {
	it('returns empty string for absent/empty rel (do-follow)', () => {
		expect(relAttr(undefined)).toBe('');
		expect(relAttr('')).toBe('');
		expect(relAttr('   ')).toBe('');
	});

	it('renders a single allowed token', () => {
		expect(relAttr('nofollow')).toBe(' rel="nofollow"');
		expect(relAttr('sponsored')).toBe(' rel="sponsored"');
	});

	it('renders sponsored+nofollow in canonical order', () => {
		expect(relAttr('sponsored nofollow')).toBe(' rel="sponsored nofollow"');
	});

	it('normalizes nofollow-sponsored token order to sponsored nofollow', () => {
		expect(relAttr('nofollow sponsored')).toBe(' rel="sponsored nofollow"');
	});

	it('collapses duplicate tokens and extra whitespace', () => {
		expect(relAttr('  nofollow   nofollow ')).toBe(' rel="nofollow"');
	});

	it('rejects unknown tokens (defence-in-depth) → empty string', () => {
		expect(relAttr('dofollow')).toBe('');
		expect(relAttr('nofollow evil')).toBe('');
		expect(relAttr('javascript:alert(1)')).toBe('');
	});
});

describe('SLUG_RE — pretty-slug charset (single OR slash-joined segments)', () => {
	it('accepts a single-segment slug (backward compatible)', () => {
		expect(SLUG_RE.test('log-in-17')).toBe(true);
		expect(SLUG_RE.test('starzino')).toBe(true);
	});

	it('accepts a multi-segment path slug (en/starzino)', () => {
		expect(SLUG_RE.test('en/starzino')).toBe(true);
		expect(SLUG_RE.test('en/starzino-casino')).toBe(true);
		expect(SLUG_RE.test('a/b/c')).toBe(true);
	});

	it('rejects leading / trailing / double slash and non-charset chars', () => {
		expect(SLUG_RE.test('/en')).toBe(false);
		expect(SLUG_RE.test('en/')).toBe(false);
		expect(SLUG_RE.test('en//starzino')).toBe(false);
		expect(SLUG_RE.test('EN/Starzino')).toBe(false);
		expect(SLUG_RE.test('en/star zino')).toBe(false);
		expect(SLUG_RE.test('')).toBe(false);
	});
});

describe('GO_PATH_REGEX — routing picks up multi-segment tokens', () => {
	it('captures a multi-segment token from /go/en/starzino', () => {
		const m = '/go/en/starzino'.match(GO_PATH_REGEX);
		expect(m?.[1]).toBe('en/starzino');
	});

	it('still captures a single-segment token (unchanged)', () => {
		expect('/go/log-in-17'.match(GO_PATH_REGEX)?.[1]).toBe('log-in-17');
	});

	it('tolerates and strips a trailing slash', () => {
		expect('/go/en/starzino/'.match(GO_PATH_REGEX)?.[1]).toBe('en/starzino');
	});

	it('does not match bare /go/ or non-/go/ paths', () => {
		expect('/go/'.match(GO_PATH_REGEX)).toBeNull();
		expect('/gopher'.match(GO_PATH_REGEX)).toBeNull();
		expect('/'.match(GO_PATH_REGEX)).toBeNull();
	});
});

describe('indexAssignmentsBySlug — resolves slash slugs', () => {
	it('keys a slash slug so /go/en/starzino resolves to its assignment', () => {
		const map = indexAssignmentsBySlug([
			{ assignment_id: 'asn_1', code: 'hero', direction: 'outgoing', target_url: 'https://x', slug: 'en/starzino' },
		]);
		expect(map.get('en/starzino')?.assignment_id).toBe('asn_1');
	});

	it('skips a malformed slash slug (leading slash) so it cannot shadow an id', () => {
		const map = indexAssignmentsBySlug([
			{ assignment_id: 'asn_2', code: 'hero', direction: 'outgoing', target_url: 'https://x', slug: '/en/starzino' },
		]);
		expect(map.has('/en/starzino')).toBe(false);
	});
});
