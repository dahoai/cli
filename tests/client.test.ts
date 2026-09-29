import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GatewayClient, NetworkError } from '../src/client.js';
import { json, startFakeGateway, testKey } from './fake-gateway.js';

type Fake = Awaited<ReturnType<typeof startFakeGateway>>;
let fake: Fake;
let client: GatewayClient;

beforeEach(async () => {
    fake = await startFakeGateway();
    client = new GatewayClient({ apiKey: testKey(), gatewayUrl: fake.url });
});
afterEach(async () => {
    await fake.close();
});

describe('GatewayClient.request', () => {
    it('sends the bearer key, method, path, query and body; and reads status, headers and body', async () => {
        const res = await client.request({
            method: 'POST',
            path: '/google/gmail/v1/users/me/messages',
            query: '?q=is%3Aunread',
            headers: { 'Content-Type': 'application/json', 'X-Custom': 'a' },
            body: '{"a":1}',
            connection: 'conn-1'
        });
        expect(res.status).toBe(200);
        expect(new TextDecoder().decode(res.body)).toContain('"ok":true');
        const sent = fake.requests[0]!;
        expect(sent.method).toBe('POST');
        expect(sent.url).toBe('/google/gmail/v1/users/me/messages?q=is%3Aunread');
        expect(sent.body).toBe('{"a":1}');
        expect(sent.headers['authorization']).toBe(`Bearer ${testKey()}`);
        expect(sent.headers['daho-connection']).toBe('conn-1');
        expect(sent.headers['x-custom']).toBe('a');
    });

    it('apps() and connections() call the discovery endpoints with GET', async () => {
        expect((await client.apps()).status).toBe(200);
        expect((await client.connections()).status).toBe(200);
        expect(fake.requests.map((r) => `${r.method} ${r.url}`)).toEqual(['GET /_/apps', 'GET /_/connections']);
    });

    it('returns non-2xx responses instead of throwing', async () => {
        fake.setHandler(() => json(409, { error: { code: 'connection_required', details: { connections: ['a', 'b'] } } }));
        const res = await client.request({ method: 'GET', path: '/slack/x' });
        expect(res.status).toBe(409);
    });

    it('does not follow redirects, so the key cannot be carried to another host', async () => {
        const evil = await startFakeGateway();
        fake.setHandler(() => ({ status: 302, headers: { location: `${evil.url}/steal` } }));
        const res = await client.request({ method: 'GET', path: '/slack/x' });
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe(`${evil.url}/steal`);
        expect(evil.requests).toHaveLength(0);
        await evil.close();
    });

    it('turns network failures and timeouts into NetworkError without leaking the key', async () => {
        const dead = new GatewayClient({ apiKey: testKey(), gatewayUrl: 'http://127.0.0.1:1' });
        await expect(dead.request({ method: 'GET', path: '/x' })).rejects.toBeInstanceOf(NetworkError);

        fake.setHandler(() => new Promise(() => undefined)); // never answers
        const slow = new GatewayClient({ apiKey: testKey(), gatewayUrl: fake.url }, fetch, 150);
        const err = await slow.request({ method: 'GET', path: '/x' }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(NetworkError);
        expect(String((err as Error).message)).toMatch(/within/);
        expect(String((err as Error).message)).not.toContain(testKey());
    });
});
