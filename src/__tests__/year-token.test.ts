import { describe, expect, it, vi, afterEach } from 'vitest';
import { processYearToken } from '../index';

describe('processYearToken (#80 — footer copyright stays current)', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('rewrites the data-year span body to the current year', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2030-07-01T00:00:00Z'));
		const html = '<p>&copy; <span data-year>2026</span> Casino X. All rights reserved.</p>';
		expect(processYearToken(html)).toBe(
			'<p>&copy; <span data-year>2030</span> Casino X. All rights reserved.</p>'
		);
	});

	it('matches the footer partial markup verbatim', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2028-01-01T00:00:00Z'));
		// Exact shape shipped in public/partials/footer.html.
		const html = '<p>&copy; <span data-year>2026</span> Casino Brand. All rights reserved.</p>';
		expect(processYearToken(html)).toContain('<span data-year>2028</span>');
	});

	it('handles extra attributes on the span (e.g. a class)', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2029-03-03T00:00:00Z'));
		const html = '<span data-year class="yr">2026</span>';
		expect(processYearToken(html)).toBe('<span data-year class="yr">2029</span>');
	});

	it('leaves HTML without a data-year span untouched', () => {
		const html = '<p>&copy; 2026 Casino X.</p>';
		expect(processYearToken(html)).toBe(html);
	});
});
