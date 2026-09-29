import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GatewayClient } from '../src/client.js';
import { MAX_TEXT_CHARS } from '../src/format.js';
import { createMcpServer } from '../src/mcp/server.js';
import { json, startFakeGateway, testKey } from './fake-gateway.js';

type Fake = Awaited<ReturnType<typeof startFakeGateway>>;
let fake: Fake;
let client: Client;

beforeEach(async () => {
    fake = await startFakeGateway();
    const server = createMcpServer(new GatewayClient({ apiKey: testKey(), gatewayUrl: fake.url }), '0.0.0-test');
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(b), client.connect(a)]);
});
afterEach(async () => {
    await client.close();
    await fake.close();
});

type Result = { isError?: boolean; content: { type: string; text: string }[] };
const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as Result;
const text = (r: Result) => r.content.map((c) => c.text).join('\n');

describe('tool list', () => {
    it('exposes four tools with the right annotations; api_write needs a summary', async () => {
        const { tools } = await client.listTools();
        const by = Object.fromEntries(tools.map((t) => [t.name, t]));
        expect(Object.keys(by).sort()).toEqual(['api_read', 'api_write', 'list_apps', 'list_connections']);
        for (const name of ['list_apps', 'list_connections', 'api_read']) {
            expect(by[name]!.annotations?.readOnlyHint, name).toBe(true);
        }
        const write = by['api_write']!;
        expect(write.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
        expect(write.inputSchema.required).toEqual(expect.arrayContaining(['app', 'method', 'path', 'summary']));
    });

    it('descriptions carry the safety rules', async () => {
        const { tools } = await client.listTools();
        const read = tools.find((t) => t.name === 'api_read')!.description!;
        const write = tools.find((t) => t.name === 'api_write')!.description!;
        expect(read).toMatch(/untrusted/i);
        expect(read).toContain('${');
        expect(write).toMatch(/summary/);
        expect(write).toMatch(/POST that only reads|read-shaped/i);
        expect(write).toMatch(/idempoten|check with a read/i);
    });
});

describe('discovery tools', () => {
    it('list_apps and list_connections return the gateway JSON', async () => {
        expect(text(await call('list_apps', {}))).toContain('"google"');
        expect(text(await call('list_connections', {}))).toContain('conn-1');
    });
});

describe('api_read', () => {
    it('GETs app + path with an encoded query and forwards headers and the connection', async () => {
        const r = await call('api_read', {
            app: 'google',
            path: '/gmail/v1/users/me/messages',
            query: { q: 'is:unread newer_than:7d', maxResults: 5, labelIds: ['INBOX', 'UNREAD'] },
            headers: { Accept: 'application/json' },
            connection: 'conn-1'
        });
        expect(r.isError).toBeFalsy();
        expect(text(r)).toMatch(/^HTTP 200/);
        const sent = fake.requests[0]!;
        expect(sent.method).toBe('GET');
        expect(sent.url).toBe('/google/gmail/v1/users/me/messages?q=is%3Aunread%20newer_than%3A7d&maxResults=5&labelIds=INBOX&labelIds=UNREAD');
        expect(sent.headers['accept']).toBe('application/json');
        expect(sent.headers['daho-connection']).toBe('conn-1');
        expect(sent.headers['authorization']).toBe(`Bearer ${testKey()}`);
    });

    it('cannot write: POST is not allowed through api_read and nothing is sent', async () => {
        const r = await call('api_read', { app: 'google', path: '/x', method: 'POST' });
        expect(r.isError).toBe(true);
        expect(fake.requests).toHaveLength(0);
    });

    it('rejects bad apps, paths (query in path, URLs, ${), and blocked headers before any request', async () => {
        const bad: Record<string, unknown>[] = [
            { app: 'https://evil.example', path: '/x' },
            { app: 'google', path: 'https://evil.example/x' },
            { app: 'google', path: '/x?y=1' },
            { app: 'google', path: '/x/${access_token}' },
            { app: 'google', path: '/x', query: { q: '${refresh_token}' } },
            { app: 'google', path: '/x', headers: { Authorization: 'Bearer other' } },
            { app: 'google', path: '/x', connection: 'a b' }
        ];
        for (const args of bad) {
            const r = await call('api_read', args);
            expect(r.isError, JSON.stringify(args)).toBe(true);
        }
        expect(fake.requests).toHaveLength(0);
    });

    it('non-2xx sets isError and adds the hint; a 409 tells the agent to ask the user', async () => {
        fake.setHandler(() => json(409, { error: { code: 'connection_required', details: { connections: ['c1', 'c2'] } } }));
        const r = await call('api_read', { app: 'slack', path: '/x' });
        expect(r.isError).toBe(true);
        expect(text(r)).toMatch(/^HTTP 409/);
        expect(text(r)).toContain('c1, c2');
        expect(text(r)).toMatch(/ask the user which/i);
    });

    it('truncates very long bodies and does not dump binary', async () => {
        fake.setHandler(() => ({ status: 200, headers: { 'content-type': 'text/plain' }, body: 'y'.repeat(MAX_TEXT_CHARS + 1000) }));
        const long = await call('api_read', { app: 'google', path: '/big' });
        expect(text(long)).toContain('truncated');
        expect(text(long).length).toBeLessThan(MAX_TEXT_CHARS + 600);

        fake.setHandler(() => ({ status: 200, headers: { 'content-type': 'image/png' }, body: Buffer.from([1, 2, 3]) }));
        expect(text(await call('api_read', { app: 'google', path: '/x.png' }))).toContain('[binary body not shown: 3 bytes');
    });

    it('a response cut at the byte cap says so instead of pretending to be complete', async () => {
        fake.setHandler(() => ({ status: 200, headers: { 'content-type': 'text/plain' }, body: 'q'.repeat(2_000_000) }));
        const r = await call('api_read', { app: 'google', path: '/huge' });
        expect(text(r)).toMatch(/response was cut/i);
        expect(text(r).length).toBeLessThan(MAX_TEXT_CHARS + 800);
    });

    it('a network failure is an error result, not a crash', async () => {
        await fake.close();
        const r = await call('api_read', { app: 'google', path: '/x' });
        expect(r.isError).toBe(true);
        expect(text(r)).toMatch(/could not reach the gateway/);
        fake = await startFakeGateway(); // so afterEach can close it
    });
});

describe('api_write', () => {
    it('needs a summary and a write method', async () => {
        expect((await call('api_write', { app: 'resend', method: 'POST', path: '/emails' })).isError).toBe(true);
        expect((await call('api_write', { app: 'resend', method: 'POST', path: '/emails', summary: 'hi' })).isError).toBe(true); // too short
        expect((await call('api_write', { app: 'resend', method: 'GET', path: '/emails', summary: 'A read does not belong here' })).isError).toBe(true);
        expect(fake.requests).toHaveLength(0);
    });

    it('sends JSON bodies with a JSON content type, and does not send the summary', async () => {
        const r = await call('api_write', {
            app: 'resend',
            method: 'POST',
            path: '/emails',
            body: { to: 'a@example.com', subject: 'Hello' },
            summary: 'Send one email to a@example.com with the subject Hello',
            headers: { 'Idempotency-Key': 'k1' }
        });
        expect(r.isError).toBeFalsy();
        const sent = fake.requests[0]!;
        expect(sent.method).toBe('POST');
        expect(sent.url).toBe('/resend/emails');
        expect(JSON.parse(sent.body)).toEqual({ to: 'a@example.com', subject: 'Hello' });
        expect(sent.headers['content-type']).toBe('application/json');
        expect(sent.headers['idempotency-key']).toBe('k1');
        expect(sent.body).not.toContain('Send one email');
    });

    it('string bodies keep the caller content type', async () => {
        await call('api_write', {
            app: 'stripe-api-key',
            method: 'POST',
            path: '/v1/customers',
            body: 'name=Ann',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            summary: 'Create a Stripe customer named Ann'
        });
        expect(fake.requests[0]!.headers['content-type']).toBe('application/x-www-form-urlencoded');
        expect(fake.requests[0]!.body).toBe('name=Ann');
    });

    it('a 502 result warns against repeating the write blindly', async () => {
        fake.setHandler(() => json(502, { error: { code: 'nango_unreachable' } }));
        const r = await call('api_write', { app: 'resend', method: 'POST', path: '/emails', summary: 'Send one email to a@example.com' });
        expect(r.isError).toBe(true);
        expect(text(r)).toMatch(/check with a read whether it already happened/i);
    });
});

describe('the key never leaks', () => {
    it('is absent from every tool result, including errors', async () => {
        const key = testKey();
        const results = [
            await call('list_apps', {}),
            await call('api_read', { app: 'google', path: '/x' }),
            await call('api_read', { app: 'google', path: '/x', headers: { Authorization: key } }),
            await call('api_write', { app: 'google', method: 'POST', path: '/x', summary: 'Do a harmless thing', body: { a: 1 } })
        ];
        fake.setHandler(() => json(401, { error: { code: 'invalid_key' } }));
        results.push(await call('api_read', { app: 'google', path: '/x' }));
        for (const r of results) {
            expect(text(r)).not.toContain(key);
        }
    });
});
