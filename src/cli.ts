import { parseArgs } from 'node:util';

import { GatewayClient, NetworkError } from './client.js';
import { ConfigError, keyLooksRight, loadConfig } from './config.js';
import { hintFor } from './format.js';
import { checkHeaders, GuardError, parseHeaderArg, splitAppPath, validateConnection, validateMethod } from './guard.js';

import type { GatewayResponse } from './client.js';
import type { Config } from './config.js';

export interface CliIo {
    env: Record<string, string | undefined>;
    stdout: (chunk: string | Uint8Array) => void;
    stderr: (text: string) => void;
    readStdin: () => Promise<Uint8Array>;
    readFile: (path: string) => Promise<Uint8Array>;
    runMcp: (config: Config) => Promise<void>;
    fetchImpl?: typeof fetch;
    version: string;
}

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

const usage = (version: string) => `daho ${version}: use your DAHO-connected apps through the DAHO API gateway

Usage:
  daho apps [--json]                      list apps and whether they are connected
  daho connections [--json]               list your connections
  daho api <path> [options]               call an app: <path> is /{app}/{native path}?{query}
  daho mcp                                run the MCP server on stdio (for Claude Code, Cursor, Codex)
  daho --version | --help

Options for "daho api":
  -X, --method METHOD    GET (default), HEAD, POST, PUT, PATCH or DELETE; POST when -d is given
  -d, --data BODY        request body: a string, @file, or @- for stdin (JSON is assumed)
  -H, --header 'N: v'    extra header (repeatable); Authorization, Host and Cookie cannot be set
      --connection ID    choose one connection when you have several for the app
  -i, --include          print the response headers to stderr

Environment:
  DAHO_API_KEY           your API key (create one in the DAHO portal, API keys page). Required.
  DAHO_GATEWAY_URL       override the gateway URL (https, or http for localhost only)

The response body goes to stdout and the HTTP status to stderr. Exit codes: 0 success, 1 HTTP error
(the body is still printed), 2 usage or configuration error, 3 network failure.
Writes act on your real accounts: check the effect before you run them.
`;

export async function runCli(argv: string[], io: CliIo): Promise<number> {
    const [command, ...rest] = argv;
    if (command === undefined) {
        io.stderr(usage(io.version));
        return 2;
    }
    if (command === '--version' || command === '-v') {
        io.stdout(`${io.version}\n`);
        return 0;
    }
    if (command === '--help' || command === '-h' || command === 'help') {
        io.stdout(usage(io.version));
        return 0;
    }
    if (!['apps', 'connections', 'api', 'mcp'].includes(command)) {
        io.stderr(`daho: unknown command "${command.slice(0, 40)}"\n\n${usage(io.version)}`);
        return 2;
    }

    try {
        // Usage errors come first, so a missing key never hides a mistake in the command itself.
        const parsed = command === 'apps' || command === 'connections' ? parseList(rest) : command === 'api' ? parseApi(rest) : undefined;
        const config = loadConfig(io.env);
        if (!keyLooksRight(config.apiKey)) {
            io.stderr('daho: warning: DAHO_API_KEY does not look like a DAHO key (daho_live_...)\n');
        }
        if (command === 'mcp') {
            await io.runMcp(config);
            return 0;
        }
        const client = new GatewayClient(config, io.fetchImpl);
        if (command === 'api') {
            return await runApi(parsed as ApiArgs, io, client);
        }
        return await runList(command as 'apps' | 'connections', parsed as { json: boolean }, io, client);
    } catch (err) {
        return fail(err, io);
    }
}

function fail(err: unknown, io: CliIo): number {
    if (err instanceof GuardError || err instanceof ConfigError) {
        io.stderr(`daho: ${err.message}\n`);
        return 2;
    }
    if (err instanceof NetworkError) {
        io.stderr(`daho: ${err.message}\n`);
        return 3;
    }
    if (err instanceof TypeError && 'code' in err && String((err as { code: unknown }).code).startsWith('ERR_PARSE_ARGS')) {
        io.stderr(`daho: ${err.message}\n`);
        return 2;
    }
    // Deliberately no message or stack: nothing about a request should ever reach the terminal by accident.
    io.stderr('daho: unexpected error\n');
    return 1;
}

function report(res: GatewayResponse, io: CliIo, include: boolean): number {
    io.stderr(`HTTP ${res.status}\n`);
    if (include) {
        for (const [name, value] of res.headers) {
            if (name.toLowerCase() !== 'set-cookie') {
                io.stderr(`${name}: ${value}\n`);
            }
        }
    }
    if (res.body.length > 0) {
        io.stdout(res.body);
    }
    const hint = hintFor(res.status, res.body, res.headers, 'cli');
    if (hint) {
        io.stderr(`hint: ${hint}\n`);
    }
    return res.status >= 200 && res.status < 300 ? 0 : 1;
}

function table(io: CliIo, header: string[], rows: string[][]): void {
    const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
    const line = (cells: string[]) => `${cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ').trimEnd()}\n`;
    io.stdout(line(header));
    for (const row of rows) {
        io.stdout(line(row));
    }
}

function parseList(args: string[]): { json: boolean } {
    const { values } = parseArgs({ args, options: { json: { type: 'boolean' } }, strict: true, allowPositionals: false });
    return { json: values.json ?? false };
}

async function runList(which: 'apps' | 'connections', opts: { json: boolean }, io: CliIo, client: GatewayClient): Promise<number> {
    const res = which === 'apps' ? await client.apps() : await client.connections();
    if (res.status < 200 || res.status >= 300) {
        io.stderr(`HTTP ${res.status}\n`);
        const hint = hintFor(res.status, res.body, res.headers, 'cli');
        if (hint) {
            io.stderr(`hint: ${hint}\n`);
        }
        return 1;
    }
    if (opts.json) {
        io.stdout(res.body);
        return 0;
    }
    let data: Record<string, unknown>[];
    try {
        const parsed = JSON.parse(new TextDecoder().decode(res.body)) as { data?: unknown };
        if (!Array.isArray(parsed.data)) {
            throw new Error('no data');
        }
        data = parsed.data as Record<string, unknown>[];
    } catch {
        io.stderr('daho: unexpected response from the gateway (not the expected JSON); try --json to see it\n');
        return 1;
    }
    if (which === 'apps') {
        table(io, ['APP', 'CONNECTED', 'CONNECTIONS'], data.map((a) => [String(a['app']), a['connected'] ? 'yes' : 'no', String(a['connections'])]));
    } else {
        table(io, ['CONNECTION ID', 'APP', 'CREATED'], data.map((c) => [String(c['connection_id']), String(c['app']), String(c['created'])]));
    }
    return 0;
}

interface ApiArgs {
    method: (typeof METHODS)[number];
    path: string;
    query: string;
    headers: Record<string, string>;
    connection: string | undefined;
    data: string | undefined;
    include: boolean;
}

/** Everything that can be wrong with the command line itself, checked before the key or the network. */
function parseApi(args: string[]): ApiArgs {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        strict: true,
        options: {
            method: { type: 'string', short: 'X' },
            data: { type: 'string', short: 'd' },
            header: { type: 'string', short: 'H', multiple: true },
            connection: { type: 'string' },
            include: { type: 'boolean', short: 'i' }
        }
    });
    const target = positionals[0];
    if (target === undefined) {
        throw new GuardError('usage: daho api <path> [options] (see "daho --help")');
    }
    if (positionals.length > 1) {
        throw new GuardError('only one path is accepted; quote it if it contains "&" or spaces');
    }
    const { app, rest, query } = splitAppPath(target);
    const method = validateMethod(values.method ?? (values.data !== undefined ? 'POST' : 'GET'), METHODS);
    const readOnly = method === 'GET' || method === 'HEAD';
    if (readOnly && values.data !== undefined) {
        throw new GuardError(`a ${method} request cannot have a body (-d); use -X POST, PUT, PATCH or DELETE`);
    }
    const headers = checkHeaders(Object.fromEntries((values.header ?? []).map(parseHeaderArg)), readOnly);
    // Object.fromEntries would silently keep the last of two identical names, so count them separately.
    const names = (values.header ?? []).map((h) => parseHeaderArg(h)[0].toLowerCase());
    if (new Set(names).size !== names.length) {
        throw new GuardError('the same header was given twice');
    }
    return {
        method,
        path: `/${app}${rest}`,
        query,
        headers,
        connection: values.connection !== undefined ? validateConnection(values.connection) : undefined,
        data: values.data,
        include: values.include ?? false
    };
}

async function runApi(a: ApiArgs, io: CliIo, client: GatewayClient): Promise<number> {
    let body: Uint8Array | undefined;
    if (a.data !== undefined) {
        if (a.data === '@-') {
            body = await io.readStdin();
        } else if (a.data.startsWith('@')) {
            const file = a.data.slice(1);
            try {
                body = await io.readFile(file);
            } catch {
                throw new GuardError(`cannot read the body file "${file.slice(0, 80)}"`);
            }
        } else {
            body = new TextEncoder().encode(a.data);
        }
    }
    const headers = { ...a.headers };
    if (body !== undefined && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = 'application/json';
    }
    try {
        const res = await client.request({ method: a.method, path: a.path, query: a.query, headers, ...(body !== undefined ? { body } : {}), ...(a.connection ? { connection: a.connection } : {}) });
        return report(res, io, a.include);
    } catch (err) {
        if (err instanceof NetworkError && a.method !== 'GET' && a.method !== 'HEAD') {
            io.stderr(`daho: ${err.message}\nhint: this was a write: check with a read whether it already happened before you repeat it.\n`);
            return 3;
        }
        throw err;
    }
}
