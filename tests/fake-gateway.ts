import http from 'node:http';

import type { AddressInfo } from 'node:net';

export interface Recorded {
    method: string;
    url: string;
    headers: http.IncomingHttpHeaders;
    body: string;
}
export interface FakeReply {
    status?: number;
    headers?: Record<string, string>;
    body?: string | Buffer;
}
export type Handler = (req: Recorded) => FakeReply | Promise<FakeReply>;

/** A key built at run time, so no key-shaped string is ever committed. */
export const testKey = (): string => `daho_live_${'T'.repeat(43)}`;

export const APPS = {
    data: [
        { app: 'google', display_name: 'Google', connected: true, connections: 1 },
        { app: 'slack', display_name: 'Slack', connected: false, connections: 0 }
    ]
};
export const CONNECTIONS = { data: [{ connection_id: 'conn-1', app: 'google', created: '2026-09-01T00:00:00Z' }] };

export const json = (status: number, value: unknown, headers: Record<string, string> = {}): FakeReply => ({
    status,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(value)
});

const defaultHandler: Handler = (req) => {
    if (req.url === '/_/apps') {
        return json(200, APPS);
    }
    if (req.url === '/_/connections') {
        return json(200, CONNECTIONS);
    }
    return json(200, { ok: true, path: req.url });
};

export async function startFakeGateway(handler: Handler = defaultHandler) {
    const requests: Recorded[] = [];
    let current = handler;
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
            void (async () => {
                const recorded: Recorded = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString() };
                requests.push(recorded);
                const reply = await current(recorded);
                res.writeHead(reply.status ?? 200, reply.headers ?? { 'content-type': 'application/json' });
                res.end(reply.body ?? '');
            })();
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}`,
        requests,
        setHandler: (h: Handler) => {
            current = h;
        },
        close: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            })
    };
}
