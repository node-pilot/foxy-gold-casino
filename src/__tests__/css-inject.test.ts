import { describe, expect, it } from 'vitest';
import { processCssInject } from '../index';

describe('processCssInject (Phase E — legacy worker-CSS-injection remediation)', () => {
	it('injects the legacy-fixes <style> before </head>', () => {
		const html = '<html><head><title>X</title></head><body></body></html>';
		const out = processCssInject(html);
		expect(out).toContain('id="levr-legacy-fixes"');
		// Injected inside <head>, before the closing tag.
		expect(out.indexOf('levr-legacy-fixes')).toBeLessThan(out.indexOf('</head>'));
	});

	it('carries all four remediation rules (buttons, logo plate, header, container)', () => {
		const out = processCssInject('<head></head>');
		// Item 1+3: header flex on the dedicated wrapper.
		expect(out).toContain(':where(.site-header .header-inner)');
		expect(out).toContain('justify-content:space-between');
		// Item 2: logo/badge white plate.
		expect(out).toContain(':where(.provider-logo,.payment-logo,.compliance-badge)');
		expect(out).toContain('background:#fff');
		// Held aff-link fix: CTA button styling.
		expect(out).toContain(':where(a.aff-link-unresolved)');
	});

	it('every selector is 0-specificity (:where) so a newer site stylesheet wins', () => {
		const out = processCssInject('<head></head>');
		const styleInner = out
			.slice(out.indexOf('<style'), out.indexOf('</style>'))
			.replace(/<style[^>]*>/, '')
			.replace(/\/\*[\s\S]*?\*\//g, ''); // strip CSS comments
		const ruleStarts = [...styleInner.matchAll(/(^|\})\s*([^{};@]+)\{/g)].map((m) => m[2].trim());
		// Sanity: we actually found rules to check.
		expect(ruleStarts.length).toBeGreaterThan(0);
		for (const sel of ruleStarts) {
			if (!sel) continue;
			expect(sel.startsWith(':where('), `selector "${sel}" is not :where()-wrapped`).toBe(true);
		}
	});

	it('prepends the style when there is no </head> (fragment safety)', () => {
		const out = processCssInject('<div>fragment</div>');
		expect(out.startsWith('<style id="levr-legacy-fixes">')).toBe(true);
		expect(out).toContain('<div>fragment</div>');
	});
});
