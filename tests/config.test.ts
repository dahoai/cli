import { describe, expect, it } from 'vitest';

import { ConfigError, keyLooksRight, loadConfig } from '../src/config.js';

const KEY = `daho_live_${'T'.repeat(43)}`;

describe('loadConfig', () => {
    it('reads the key and defaults the gateway URL', () => {
        expect(loadConfig({ DAHO_API_KEY: KEY })).toEqual({ apiKey: KEY, gatewayUrl: 'https://gateway.daho.ai' });
    });

    it('trims the key and a trailing slash on the URL', () => {
        expect(loadConfig({ DAHO_API_KEY: `  ${KEY}\n`, DAHO_GATEWAY_URL: 'https://g.example.com///' })).toEqual({ apiKey: KEY, gatewayUrl: 'https://g.example.com' });
    });

    it('needs a key, and never echoes it in an error', () => {
        expect(() => loadConfig({})).toThrow(/DAHO_API_KEY/);
        expect(() => loadConfig({ DAHO_API_KEY: '   ' })).toThrow(ConfigError);
        try {
            loadConfig({ DAHO_API_KEY: `${KEY}\r\nX-Evil: 1` });
        } catch (err) {
            expect(String((err as Error).message)).not.toContain(KEY);
            expect(err).toBeInstanceOf(ConfigError);
        }
    });

    it('allows https, and http only for loopback (so the key cannot travel in clear text)', () => {
        expect(loadConfig({ DAHO_API_KEY: KEY, DAHO_GATEWAY_URL: 'http://127.0.0.1:3004' }).gatewayUrl).toBe('http://127.0.0.1:3004');
        expect(loadConfig({ DAHO_API_KEY: KEY, DAHO_GATEWAY_URL: 'http://localhost:8080' }).gatewayUrl).toBe('http://localhost:8080');
        for (const bad of ['http://gateway.daho.ai', 'ftp://x', 'not a url', 'https://user:pw@g.example.com', 'https://g.example.com/?x=1', 'https://g.example.com/#f']) {
            expect(() => loadConfig({ DAHO_API_KEY: KEY, DAHO_GATEWAY_URL: bad }), bad).toThrow(ConfigError);
        }
    });
});

describe('keyLooksRight', () => {
    it('recognises the daho_live_ shape (used for a warning only)', () => {
        expect(keyLooksRight(KEY)).toBe(true);
        expect(keyLooksRight('sk-something')).toBe(false);
    });
});
