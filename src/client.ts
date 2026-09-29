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
}

export interface GatewayResponse {
    status: number;
    headers: Headers;
    body: Uint8Array;
}

/** The gateway could not be reached, or did not finish in time. Messages never contain the key or the headers. */
export class NetworkError extends Error {}

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
        try {
            const res = await this.fetchImpl(url, {
                method: req.method,
                headers,
                ...(req.body !== undefined ? { body: req.body as BodyInit } : {}),
                redirect: 'manual',
                signal: AbortSignal.timeout(this.timeoutMs)
            });
            return { status: res.status, headers: res.headers, body: new Uint8Array(await res.arrayBuffer()) };
        } catch (err) {
            throw new NetworkError(describeFailure(err, this.timeoutMs));
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
