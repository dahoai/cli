import { describe, expect, it } from 'vitest';

import { bodyForMcp, hintFor, isTextual, MAX_TEXT_CHARS } from '../src/format.js';

const enc = (s: string) => new TextEncoder().encode(s);
const err = (code: string, extra: Record<string, unknown> = {}) => enc(JSON.stringify({ error: { code, message: 'm', ...extra } }));

describe('isTextual', () => {
    it('treats json, text, xml, form and +json/+xml types as text; images and octet-stream as binary', () => {
        for (const t of ['application/json', 'application/json; charset=utf-8', 'text/plain', 'text/html', 'application/xml', 'application/x-www-form-urlencoded', 'application/vnd.api+json', 'application/atom+xml', 'application/x-ndjson', 'application/csv', 'application/x-yaml', 'application/toml', null]) {
            expect(isTextual(t), String(t)).toBe(true);
        }
        for (const t of ['image/png', 'application/octet-stream', 'application/pdf', 'audio/mpeg']) {
            expect(isTextual(t), t).toBe(false);
        }
    });
});

describe('bodyForMcp', () => {
    it('returns text as is, and marks an empty body', () => {
        expect(bodyForMcp(enc('{"a":1}'), 'application/json')).toBe('{"a":1}');
        expect(bodyForMcp(new Uint8Array(), 'application/json')).toBe('(empty body)');
    });

    it('cuts very long text with a notice that says how much was dropped', () => {
        const long = 'x'.repeat(MAX_TEXT_CHARS + 500);
        const out = bodyForMcp(enc(long), 'text/plain');
        expect(out.startsWith('x'.repeat(100))).toBe(true);
        expect(out.length).toBeLessThan(long.length);
        expect(out).toContain(`truncated: showing ${MAX_TEXT_CHARS} of ${MAX_TEXT_CHARS + 500} characters`);
    });

    it('does not dump binary bodies into text', () => {
        expect(bodyForMcp(new Uint8Array([1, 2, 3, 4]), 'image/png')).toBe('[binary body not shown: 4 bytes, type image/png]');
    });
});

describe('hintFor', () => {
    const none = new Headers();

    it('says nothing on success', () => {
        expect(hintFor(200, enc('{}'), none, 'cli')).toBeUndefined();
    });

    it('401: check or recreate the key', () => {
        expect(hintFor(401, err('invalid_key'), none, 'cli')).toMatch(/DAHO_API_KEY.*portal/i);
    });

    it('404 variants point to the right next step', () => {
        expect(hintFor(404, err('not_connected'), none, 'cli')).toMatch(/connect it in the DAHO portal/i);
        expect(hintFor(404, err('unknown_app'), none, 'cli')).toMatch(/daho apps/);
        expect(hintFor(404, err('connection_not_found'), none, 'cli')).toMatch(/daho connections/);
    });

    it('409 lists the candidates and tells the caller to ask the user, with wording per surface', () => {
        const body = err('connection_required', { details: { connections: ['id-1', 'id-2'] } });
        const cli = hintFor(409, body, none, 'cli')!;
        expect(cli).toContain('id-1, id-2');
        expect(cli).toContain('--connection');
        const mcp = hintFor(409, body, none, 'mcp')!;
        expect(mcp).toContain('id-1, id-2');
        expect(mcp).toMatch(/ask the user which/i);
        expect(mcp).toContain('"connection"');
        expect(mcp).not.toContain('--connection');
    });

    it('429 shows the Retry-After value', () => {
        expect(hintFor(429, err('rate_limited'), new Headers({ 'retry-after': '3' }), 'cli')).toMatch(/3 seconds/);
    });

    it('5xx and timeouts warn against blindly repeating a write', () => {
        for (const status of [500, 502, 504]) {
            expect(hintFor(status, err('nango_unreachable'), none, 'mcp'), String(status)).toMatch(/check with a read whether it already happened/i);
        }
    });

    it('400 invalid_path, 413 and provider errors', () => {
        expect(hintFor(400, err('invalid_path'), none, 'cli')).toMatch(/path/i);
        expect(hintFor(413, err('body_too_large'), none, 'cli')).toMatch(/10 MB/);
        expect(hintFor(403, enc('{"error":"forbidden"}'), none, 'cli')).toMatch(/permission|scope/i);
    });

    it('survives non-JSON and odd error shapes', () => {
        expect(hintFor(404, enc('<html>nope</html>'), none, 'cli')).toBeUndefined();
        expect(hintFor(404, enc('{"error":"a string"}'), none, 'cli')).toBeUndefined();
    });
});
