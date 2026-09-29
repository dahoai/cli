import type { Config } from './config.js';

export interface GatewayRequest {
    method: string;
    /** "/{app}/{native path}" or a discovery path such as "/_/apps". */
    path: string;
    /** "" or "?a=1&b=2", already encoded. */
    query?: string;
    /** Already checked by guard.checkHeaders. */
    headers?: Record<string, string>;
    body?: string | Uint8Array;
    connection?: string;
    /** Stop reading the response body after this many bytes (the result is marked truncated). */
    maxBytes?: number;
}

export interface GatewayResponse {
    status: number;
    headers: Headers;
    body: Uint8Array;
    /** True when the body was cut at maxBytes. */
    truncated?: boolean;
}

/** The gateway could not be reached, or did not finish in time. Messages never contain the key or the headers. */
export class NetworkError extends Error {}

const BODY_LIMIT_MS = 10 * 60_000;

async function readBody(res: Response, maxBytes?: number): Promise<{ body: Uint8Array; truncated: boolean }> {
    if (maxBytes === undefined || !res.body) {
        return { body: new Uint8Array(await res.arrayBuffer()), truncated: false };
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = res.body.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        chunks.push(value);
        size += value.length;
        if (size > maxBytes) {
            await reader.cancel();
            break;
        }
    }
    const all = Buffer.concat(chunks);
    return { body: new Uint8Array(all.subarray(0, maxBytes)), truncated: size > maxBytes };
}

/**
 * The only code that talks to the network or holds the API key. It sends one request, follows no redirects,
 * retries nothing (a repeated write can act twice), and never puts request headers into an error.
 */
export class GatewayClient {
    constructor(
        private readonly config: Config,
        private readonly fetchImpl: typeof fetch = fetch,
        // The gateway waits up to 60 s for the app's first byte; leave a margin.
        private readonly timeoutMs = 70_000
    ) {}

    async request(req: GatewayRequest): Promise<GatewayResponse> {
        const headers = new Headers(req.headers);
        headers.set('Authorization', `Bearer ${this.config.apiKey}`);
        if (req.connection) {
            headers.set('DAHO-Connection', req.connection);
        }
        const url = `${this.config.gatewayUrl}${req.path}${req.query ?? ''}`;
        // The timeout covers the wait for the response headers; a body that keeps streaming is allowed to
        // finish (bounded by BODY_LIMIT_MS) so large downloads are not cut at 70 s.
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), this.timeoutMs);
        try {
            const res = await this.fetchImpl(url, {
                method: req.method,
                headers,
                ...(req.body !== undefined ? { body: req.body as BodyInit } : {}),
                redirect: 'manual',
                signal: abort.signal
            });
            clearTimeout(timer);
            const bodyTimer = setTimeout(() => abort.abort(), BODY_LIMIT_MS);
            try {
                const { body, truncated } = await readBody(res, req.maxBytes);
                return { status: res.status, headers: res.headers, body, ...(truncated ? { truncated } : {}) };
            } finally {
                clearTimeout(bodyTimer);
            }
        } catch (err) {
            throw new NetworkError(describeFailure(err, this.timeoutMs));
        } finally {
            clearTimeout(timer);
        }
    }

    apps(): Promise<GatewayResponse> {
        return this.request({ method: 'GET', path: '/_/apps' });
    }

    connections(): Promise<GatewayResponse> {
        return this.request({ method: 'GET', path: '/_/connections' });
    }
}

function describeFailure(err: unknown, timeoutMs: number): string {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        return `no answer from the gateway within ${Math.round(timeoutMs / 1000)} seconds`;
    }
    const code = err instanceof Error && err.cause && typeof err.cause === 'object' && 'code' in err.cause ? String((err.cause as { code: unknown }).code) : '';
    return `could not reach the gateway${code ? ` (${code})` : ''}`;
}
