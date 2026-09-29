import { describe, expect, it } from 'vitest';

import {
    buildQuery,
    checkHeaders,
    GuardError,
    parseHeaderArg,
    splitAppPath,
    validateApp,
    validateConnection,
    validateMethod,
    validateNativePath,
    validateToolPath
} from '../src/guard.js';

describe('validateApp', () => {
    it('accepts plain integration keys and rejects anything else', () => {
        for (const ok of ['google', 'google-ads', 'stripe-api-key', 'a.b_c-1']) {
            expect(validateApp(ok)).toBe(ok);
        }
        for (const bad of ['', '-x', '_x', 'a b', 'a/b', 'https://evil.example', '../x', 'a\nb', 'a'.repeat(256)]) {
            expect(() => validateApp(bad), JSON.stringify(bad)).toThrow(GuardError);
        }
    });
});

describe('validateNativePath and validateToolPath', () => {
    it('accepts ordinary native paths', () => {
        for (const ok of ['/gmail/v1/users/me/profile', '/', '/v3/sites/https%3A%2F%2Fexample.com%2F/sitemaps', '/graph/v1.0/users']) {
            expect(validateNativePath(ok)).toBe(ok);
        }
    });

    it('refuses URLs, leading double slash, backslashes, control characters and template syntax', () => {
        const bad = ['gmail/v1', 'https://evil.example/x', '//evil.example/x', '/a\\b', '/a\nb', '/a\u0000b', '/x/${access_token}', ''];
        for (const p of bad) {
            expect(() => validateNativePath(p), JSON.stringify(p)).toThrow(GuardError);
        }
    });

    it('validateToolPath also refuses ? and # (query parameters belong in the query argument)', () => {
        expect(validateToolPath('/a/b')).toBe('/a/b');
        expect(() => validateToolPath('/a/b?x=1')).toThrow(/query/);
        expect(() => validateToolPath('/a/b#frag')).toThrow(GuardError);
    });
});

describe('splitAppPath', () => {
    it('splits /{app}/{native path}?{query}', () => {
        expect(splitAppPath('/google/gmail/v1/users/me/messages?q=is%3Aunread&max=5')).toEqual({
            app: 'google',
            rest: '/gmail/v1/users/me/messages',
            query: '?q=is%3Aunread&max=5'
        });
        expect(splitAppPath('/slack')).toEqual({ app: 'slack', rest: '', query: '' });
    });

    it('refuses full URLs, empty apps and double slashes after the app', () => {
        for (const bad of ['https://gateway.daho.ai/google/x', 'google/x', '//google/x', '/', '/slack//evil.test/x', '/-bad/x']) {
            expect(() => splitAppPath(bad), bad).toThrow(GuardError);
        }
    });
});

describe('buildQuery', () => {
    it('encodes scalars and repeats array values', () => {
        expect(buildQuery(undefined)).toBe('');
        expect(buildQuery({})).toBe('');
        expect(buildQuery({ q: 'is:unread newer_than:7d', maxResults: 5, on: true })).toBe('?q=is%3Aunread%20newer_than%3A7d&maxResults=5&on=true');
        expect(buildQuery({ metadataHeaders: ['From', 'Subject'], skip: undefined, nope: null })).toBe('?metadataHeaders=From&metadataHeaders=Subject');
    });

    it('refuses control characters and template syntax in keys or values', () => {
        expect(() => buildQuery({ q: 'a\nb' })).toThrow(GuardError);
        expect(() => buildQuery({ q: '${refresh_token}' })).toThrow(GuardError);
        expect(() => buildQuery({ '${x}': '1' })).toThrow(GuardError);
    });
});

describe('checkHeaders and parseHeaderArg', () => {
    it('passes ordinary headers through', () => {
        expect(checkHeaders({ 'Content-Type': 'application/json', 'X-Custom': 'a b' })).toEqual({ 'Content-Type': 'application/json', 'X-Custom': 'a b' });
        expect(checkHeaders(undefined)).toEqual({});
    });

    it('refuses headers the tool sets itself, bad names and control characters', () => {
        for (const name of ['Authorization', 'authorization', 'Host', 'Cookie', 'Content-Length', 'Connection', 'Transfer-Encoding', 'DAHO-Connection']) {
            expect(() => checkHeaders({ [name]: 'x' }), name).toThrow(/cannot be overridden|set by the tool/);
        }
        expect(() => checkHeaders({ 'Bad Name': 'x' })).toThrow(GuardError);
        expect(() => checkHeaders({ 'X-A': 'line1\r\nX-B: evil' })).toThrow(GuardError);
    });

    it('parses "Name: value" arguments', () => {
        expect(parseHeaderArg('X-Custom: a: b')).toEqual(['X-Custom', 'a: b']);
        expect(() => parseHeaderArg('no colon')).toThrow(GuardError);
        expect(() => parseHeaderArg(': value')).toThrow(GuardError);
    });
});

describe('validateConnection and validateMethod', () => {
    it('accepts ids and refuses whitespace, control characters and empties', () => {
        expect(validateConnection('3fd0cc49-1234')).toBe('3fd0cc49-1234');
        for (const bad of ['', 'a b', 'a\nb', 'x'.repeat(256)]) {
            expect(() => validateConnection(bad)).toThrow(GuardError);
        }
    });

    it('normalises the method and enforces the allowed list', () => {
        expect(validateMethod('get', ['GET', 'HEAD'] as const)).toBe('GET');
        expect(() => validateMethod('POST', ['GET', 'HEAD'] as const)).toThrow(/GET, HEAD/);
    });
});
