import { describe, expect, it } from 'vitest';
import { processCfBeacon } from '../index';

describe('processCfBeacon (#102 — Cloudflare Web Analytics RUM beacon)', () => {
	it('injects the beacon before </body> when a site_tag is bound (zoned site)', () => {
		const html = '<html><body><h1>Hi</h1></body></html>';
		const out = processCfBeacon(html, 'tag-abc123');
		expect(out).toContain('https://static.cloudflareinsights.com/beacon.min.js');
		expect(out).toContain('data-cf-beacon=\'{"token": "tag-abc123"}\'');
		// Injected just before the closing body tag.
		expect(out.indexOf('beacon.min.js')).toBeLessThan(out.indexOf('</body>'));
	});

	it('does NOT inject when RUM_SITE_TAG is undefined (workers.dev-only build)', () => {
		const html = '<html><body><h1>Hi</h1></body></html>';
		expect(processCfBeacon(html, undefined)).toBe(html);
		expect(processCfBeacon(html, undefined)).not.toContain('cloudflareinsights');
	});

	it('falls back to </html> when there is no </body>', () => {
		const html = '<html><h1>Hi</h1></html>';
		const out = processCfBeacon(html, 'tag-x');
		expect(out).toContain('cloudflareinsights');
		expect(out.indexOf('beacon.min.js')).toBeLessThan(out.indexOf('</html>'));
	});

	it('uses the EXACT V2 injectCfAnalytics snippet string (cross-version parity)', () => {
		// Byte-identical to packages/builder/src/steps/generate.ts injectCfAnalytics.
		const out = processCfBeacon('<body></body>', 'TKN');
		expect(out).toContain(
			`<script defer src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{"token": "TKN"}'></script>`
		);
	});
});
