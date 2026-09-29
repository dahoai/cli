import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { promisify } from 'node:util';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startFakeGateway, testKey } from './fake-gateway.js';

const BIN = new URL('../dist/bin.js', import.meta.url).pathname;
const run = promisify(execFile);
type Fake = Awaited<ReturnType<typeof startFakeGateway>>;
let fake: Fake;

beforeEach(async () => {
    expect(existsSync(BIN), 'dist/bin.js is missing: run "npm run build" first').toBe(true);
    fake = await startFakeGateway();
});
afterEach(async () => {
    await fake.close();
});

const env = () => ({ ...process.env, DAHO_API_KEY: testKey(), DAHO_GATEWAY_URL: fake.url });

describe('the built binary', () => {
    it('has a node shebang and is executable', () => {
        expect(readFileSync(BIN, 'utf8').startsWith('#!/usr/bin/env node')).toBe(true);
        expect(statSync(BIN).mode & 0o111).not.toBe(0);
    });

    it('--version and --help work without a key', async () => {
        const noKey = { ...process.env, DAHO_API_KEY: undefined } as NodeJS.ProcessEnv;
        const v = await run(process.execPath, [BIN, '--version'], { env: noKey });
        expect(v.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
        const h = await run(process.execPath, [BIN, '--help'], { env: noKey });
        expect(h.stdout).toMatch(/daho api <path>/);
    });

    it('apps talks to the gateway and prints the table', async () => {
        const r = await run(process.execPath, [BIN, 'apps'], { env: env() });
        expect(r.stdout).toMatch(/google\s+yes\s+1/);
        expect(r.stdout + r.stderr).not.toContain(testKey());
        expect(fake.requests[0]!.headers['authorization']).toBe(`Bearer ${testKey()}`);
    });

    it('api sets the exit code from the HTTP status and keeps the key out of all output', async () => {
        fake.setHandler(() => ({ status: 404, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: { code: 'not_connected' } }) }));
        const r = await run(process.execPath, [BIN, 'api', '/slack/x'], { env: env() }).catch((e: { code: number; stdout: string; stderr: string }) => e);
        expect((r as { code: number }).code).toBe(1);
        expect((r as { stderr: string }).stderr).toMatch(/connect it in the DAHO portal/i);
        expect((r as { stdout: string }).stdout + (r as { stderr: string }).stderr).not.toContain(testKey());
    });
});

describe('daho mcp over stdio', () => {
    it('a real MCP client can list tools and call list_apps and api_read through the child process', async () => {
        const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, 'mcp'], env: env() as Record<string, string> });
        const client = new Client({ name: 'e2e', version: '0' });
        await client.connect(transport);
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name).sort()).toEqual(['api_read', 'api_write', 'list_apps', 'list_connections']);
        const apps = (await client.callTool({ name: 'list_apps', arguments: {} })) as { content: { text: string }[] };
        expect(apps.content[0]!.text).toContain('"google"');
        const read = (await client.callTool({ name: 'api_read', arguments: { app: 'google', path: '/gmail/v1/users/me/profile' } })) as { content: { text: string }[] };
        expect(read.content[0]!.text).toMatch(/^HTTP 200/);
        expect(read.content[0]!.text).not.toContain(testKey());
        expect(fake.requests.some((r) => r.url === '/google/gmail/v1/users/me/profile')).toBe(true);
        await client.close();
    });

    it('exits cleanly (code 0, silent stderr) when the client disconnects', async () => {
        const child = spawn(process.execPath, [BIN, 'mcp'], { env: env(), stdio: ['pipe', 'pipe', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
        const exit = new Promise<number | null>((resolve) => child.on('close', resolve));
        child.stdin.end();
        expect(await exit).toBe(0);
        expect(stderr).toBe('');
    });

    it('a missing key fails fast on stderr and never speaks the protocol on stdout', async () => {
        const noKey = { ...process.env, DAHO_API_KEY: undefined } as NodeJS.ProcessEnv;
        const r = await run(process.execPath, [BIN, 'mcp'], { env: noKey }).catch((e: { code: number; stdout: string; stderr: string }) => e);
        expect((r as { code: number }).code).toBe(2);
        expect((r as { stdout: string }).stdout).toBe('');
        expect((r as { stderr: string }).stderr).toMatch(/DAHO_API_KEY/);
    });
});
