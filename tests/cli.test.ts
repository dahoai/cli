import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCli } from '../src/cli.js';
import { json, startFakeGateway, testKey } from './fake-gateway.js';

import type { CliIo } from '../src/cli.js';
import type { Config } from '../src/config.js';

type Fake = Awaited<ReturnType<typeof startFakeGateway>>;
let fake: Fake;

beforeEach(async () => {
    fake = await startFakeGateway();
});
afterEach(async () => {
    await fake.close();
});

function harness(extra: Partial<CliIo> = {}, env: Record<string, string | undefined> = {}) {
    const out: (string | Uint8Array)[] = [];
    const err: string[] = [];
    let mcpConfig: Config | undefined;
    const io: CliIo = {
        env: { DAHO_API_KEY: testKey(), DAHO_GATEWAY_URL: fake.url, ...env },
        stdout: (c) => out.push(c),
        stderr: (t) => err.push(t),
        readStdin: () => Promise.resolve(new TextEncoder().encode('{"from":"stdin"}')),
        readFile: (p) => (p === '/tmp/body.json' ? Promise.resolve(new TextEncoder().encode('{"from":"file"}')) : Promise.reject(new Error('ENOENT'))),
        runMcp: (config) => {
            mcpConfig = config;
            return Promise.resolve();
        },
        version: '9.9.9',
        ...extra
    };
    const stdout = () => out.map((c) => (typeof c === 'string' ? c : new TextDecoder().decode(c))).join('');
    return { io, stdout, stderr: () => err.join(''), mcpConfig: () => mcpConfig };
}
const run = (argv: string[], h = harness()) => runCli(argv, h.io).then((code) => ({ code, stdout: h.stdout(), stderr: h.stderr(), h }));

describe('help and version', () => {
    it('prints usage and the version without needing a key', async () => {
        const noKey = harness({}, { DAHO_API_KEY: undefined });
        expect((await run(['--version'], noKey)).stdout).toBe('9.9.9\n');
        const help = await run(['--help'], harness({}, { DAHO_API_KEY: undefined }));
        expect(help.code).toBe(0);
        expect(help.stdout).toMatch(/daho api <path>/);
        expect(help.stdout).toMatch(/DAHO_API_KEY/);
    });

    it('no command or an unknown command is a usage error (exit 2)', async () => {
        expect((await run([])).code).toBe(2);
        const bad = await run(['frobnicate']);
        expect(bad.code).toBe(2);
        expect(bad.stderr).toMatch(/unknown command/i);
    });

    it('a missing key is exit 2 and says how to fix it', async () => {
        const r = await run(['apps'], harness({}, { DAHO_API_KEY: undefined }));
        expect(r.code).toBe(2);
        expect(r.stderr).toMatch(/DAHO_API_KEY/);
    });
});

describe('daho apps / connections', () => {
    it('prints a table, or the gateway JSON with --json', async () => {
        const table = await run(['apps']);
        expect(table.code).toBe(0);
        expect(table.stdout).toMatch(/APP\s+CONNECTED\s+CONNECTIONS/);
        expect(table.stdout).toMatch(/google\s+yes\s+1/);
        expect(table.stdout).toMatch(/slack\s+no\s+0/);

        const raw = await run(['apps', '--json']);
        expect(JSON.parse(raw.stdout).data).toHaveLength(2);

        const conns = await run(['connections']);
        expect(conns.stdout).toMatch(/CONNECTION ID\s+APP\s+CREATED/);
        expect(conns.stdout).toContain('conn-1');
    });

    it('a rejected key exits 1 with the hint on stderr', async () => {
        fake.setHandler(() => json(401, { error: { code: 'invalid_key', message: 'x' } }));
        const r = await run(['apps']);
        expect(r.code).toBe(1);
        expect(r.stderr).toMatch(/HTTP 401/);
        expect(r.stderr).toMatch(/hint: .*DAHO_API_KEY/);
    });
});

describe('daho api', () => {
    it('GETs the path, prints the body to stdout and the status to stderr', async () => {
        const r = await run(['api', '/google/gmail/v1/users/me/profile']);
        expect(r.code).toBe(0);
        expect(JSON.parse(r.stdout).path).toBe('/google/gmail/v1/users/me/profile');
        expect(r.stderr).toBe('HTTP 200\n');
        expect(fake.requests[0]!.method).toBe('GET');
        expect(fake.requests[0]!.headers['authorization']).toBe(`Bearer ${testKey()}`);
    });

    it('keeps an inline query string, and sends POST with a JSON body when -d is given', async () => {
        await run(['api', '/google/gmail/v1/users/me/messages?q=is%3Aunread', '-d', '{"a":1}']);
        const sent = fake.requests[0]!;
        expect(sent.method).toBe('POST');
        expect(sent.url).toBe('/google/gmail/v1/users/me/messages?q=is%3Aunread');
        expect(sent.body).toBe('{"a":1}');
        expect(sent.headers['content-type']).toBe('application/json');
    });

    it('reads bodies from a file (@path) and from stdin (@-)', async () => {
        await run(['api', '/slack/x', '-X', 'PUT', '-d', '@/tmp/body.json']);
        await run(['api', '/slack/x', '-d', '@-']);
        expect(fake.requests[0]!.body).toBe('{"from":"file"}');
        expect(fake.requests[0]!.method).toBe('PUT');
        expect(fake.requests[1]!.body).toBe('{"from":"stdin"}');
        const missing = await run(['api', '/slack/x', '-d', '@/nope.json']);
        expect(missing.code).toBe(2);
    });

    it('forwards custom headers and --connection; a caller Content-Type wins', async () => {
        await run(['api', '/stripe-api-key/v1/customers', '-X', 'POST', '-d', 'name=Ann', '-H', 'Content-Type: application/x-www-form-urlencoded', '-H', 'Idempotency-Key: k1', '--connection', 'conn-9']);
        const sent = fake.requests[0]!;
        expect(sent.headers['content-type']).toBe('application/x-www-form-urlencoded');
        expect(sent.headers['idempotency-key']).toBe('k1');
        expect(sent.headers['daho-connection']).toBe('conn-9');
    });

    it('refuses full URLs, blocked headers, bad methods and extra arguments (exit 2, nothing sent)', async () => {
        const cases: string[][] = [
            ['api', 'https://evil.example/x'],
            ['api', '/x/y', '-H', 'Authorization: Bearer other'],
            ['api', '/x/y', '-H', 'Host: evil.example'],
            ['api', '/x/y', '-X', 'TRACE'],
            ['api', '/x/y', 'extra'],
            ['api'],
            ['api', '/x/y', '--nope']
        ];
        for (const argv of cases) {
            const r = await run(argv);
            expect(r.code, argv.join(' ')).toBe(2);
        }
        expect(fake.requests).toHaveLength(0);
    });

    it('non-2xx exits 1 but still prints the body; -i shows response headers (never Set-Cookie) on stderr', async () => {
        fake.setHandler(() => json(429, { error: { code: 'rate_limited' } }, { 'retry-after': '2', 'set-cookie': 'a=b', 'x-provider': 'yes' }));
        const r = await run(['api', '/slack/x', '-i']);
        expect(r.code).toBe(1);
        expect(r.stdout).toContain('rate_limited');
        expect(r.stderr).toMatch(/HTTP 429/);
        expect(r.stderr).toMatch(/x-provider: yes/);
        expect(r.stderr).not.toMatch(/set-cookie/i);
        expect(r.stderr).toMatch(/2 seconds/);
    });

    it('a 409 prints the candidate ids and how to choose', async () => {
        fake.setHandler(() => json(409, { error: { code: 'connection_required', details: { connections: ['c1', 'c2'] } } }));
        const r = await run(['api', '/slack/x']);
        expect(r.code).toBe(1);
        expect(r.stderr).toContain('c1, c2');
        expect(r.stderr).toContain('--connection');
    });

    it('writes binary bodies to stdout untouched', async () => {
        fake.setHandler(() => ({ status: 200, headers: { 'content-type': 'image/png' }, body: Buffer.from([0, 1, 2, 255]) }));
        const chunks: (string | Uint8Array)[] = [];
        const h = harness({ stdout: (c) => chunks.push(c) });
        await runCli(['api', '/google/x.png'], h.io);
        const bytes = chunks.find((c): c is Uint8Array => typeof c !== 'string');
        expect(Array.from(bytes ?? [])).toEqual([0, 1, 2, 255]);
    });

    it('a network failure exits 3', async () => {
        const dead = harness({}, { DAHO_GATEWAY_URL: 'http://127.0.0.1:1' });
        expect((await run(['apps'], dead)).code).toBe(3);
    });
});

describe('daho mcp', () => {
    it('hands the validated config to the MCP runner', async () => {
        const h = harness();
        expect(await runCli(['mcp'], h.io)).toBe(0);
        expect(h.mcpConfig()).toEqual({ apiKey: testKey(), gatewayUrl: fake.url });
    });
});

describe('the key never leaks', () => {
    it('is absent from stdout and stderr for every command and error path', async () => {
        const key = testKey();
        const argvs: string[][] = [['--help'], ['--version'], ['apps'], ['connections'], ['api', '/google/x'], ['api', 'https://evil.example/x'], ['api', '/x', '-H', 'Authorization: x'], ['frobnicate']];
        for (const argv of argvs) {
            const r = await run(argv);
            expect(r.stdout + r.stderr, argv.join(' ')).not.toContain(key);
        }
        fake.setHandler(() => json(500, { error: { code: 'nango_unreachable' } }));
        const failing = await run(['api', '/google/x']);
        expect(failing.stdout + failing.stderr).not.toContain(key);
    });
});

describe('minor hardening', () => {
    it('usage errors come before the missing-key error', async () => {
        const noKey = harness({}, { DAHO_API_KEY: undefined });
        const r = await run(['api'], noKey);
        expect(r.code).toBe(2);
        expect(r.stderr).toMatch(/usage: daho api/);
        expect(r.stderr).not.toMatch(/DAHO_API_KEY/);
        expect((await run(['apps', '--nope'], harness({}, { DAHO_API_KEY: undefined }))).stderr).not.toMatch(/DAHO_API_KEY/);
    });

    it('refuses a body on GET/HEAD locally (exit 2, nothing sent)', async () => {
        const r = await run(['api', '/google/x', '-X', 'GET', '-d', 'hi']);
        expect(r.code).toBe(2);
        expect(r.stderr).toMatch(/GET|HEAD/);
        expect(fake.requests).toHaveLength(0);
    });

    it('refuses duplicate headers and non-ASCII values as usage errors', async () => {
        expect((await run(['api', '/x/y', '-H', 'X-A: 1', '-H', 'x-a: 2'])).code).toBe(2);
        expect((await run(['api', '/x/y', '-H', 'X-A: é€'])).code).toBe(2);
        expect((await run(['api', '/x/y', '--connection', 'é€'])).code).toBe(2);
        expect(fake.requests).toHaveLength(0);
    });

    it('method-override headers are refused on reads and allowed on writes', async () => {
        expect((await run(['api', '/x/y', '-H', 'X-HTTP-Method-Override: DELETE'])).code).toBe(2);
        expect(fake.requests).toHaveLength(0);
        expect((await run(['api', '/x/y', '-X', 'POST', '-d', '{}', '-H', 'X-HTTP-Method-Override: PATCH'])).code).toBe(0);
    });

    it('--json prints the gateway response exactly as received', async () => {
        const r = await run(['apps', '--json']);
        expect(r.stdout).toBe(JSON.stringify((await import('./fake-gateway.js')).APPS));
    });

    it('apps/connections survive a 2xx body that is not the expected JSON', async () => {
        fake.setHandler(() => ({ status: 200, headers: { 'content-type': 'text/html' }, body: '<html>captive portal</html>' }));
        const r = await run(['apps']);
        expect(r.code).toBe(1);
        expect(r.stderr).toMatch(/unexpected response/i);
        fake.setHandler(() => json(200, { nope: true }));
        expect((await run(['connections'])).stderr).toMatch(/unexpected response/i);
    });

    it('a network failure on a write says to check before repeating; on a read it does not', async () => {
        const dead = () => harness({}, { DAHO_GATEWAY_URL: 'http://127.0.0.1:1' });
        const write = await run(['api', '/resend/emails', '-X', 'POST', '-d', '{}'], dead());
        expect(write.code).toBe(3);
        expect(write.stderr).toMatch(/check with a read whether it already happened/i);
        const read = await run(['api', '/resend/emails'], dead());
        expect(read.code).toBe(3);
        expect(read.stderr).not.toMatch(/check with a read/i);
    });
});
