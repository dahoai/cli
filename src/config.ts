export interface Config {
    apiKey: string;
    /** Without a trailing slash. */
    gatewayUrl: string;
}

/** A configuration problem. Messages never contain the key. */
export class ConfigError extends Error {}

const DEFAULT_GATEWAY = 'https://gateway.daho.ai';

export function loadConfig(env: Record<string, string | undefined>): Config {
    const apiKey = env['DAHO_API_KEY']?.trim();
    if (!apiKey) {
        throw new ConfigError('set DAHO_API_KEY (create a key in the DAHO portal, on the API keys page)');
    }
    if (!/^[\x21-\x7e]+$/.test(apiKey)) {
        throw new ConfigError('DAHO_API_KEY contains whitespace, control or non-ASCII characters');
    }

    const raw = (env['DAHO_GATEWAY_URL'] ?? DEFAULT_GATEWAY).trim().replace(/\/+$/, '');
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new ConfigError('DAHO_GATEWAY_URL is not a valid URL');
    }
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
        throw new ConfigError('DAHO_GATEWAY_URL must use https (http is only allowed for localhost)');
    }
    if (url.username || url.password || url.search || url.hash) {
        throw new ConfigError('DAHO_GATEWAY_URL must not contain credentials, a query or a fragment');
    }
    return { apiKey, gatewayUrl: raw };
}

export function keyLooksRight(key: string): boolean {
    return /^daho_live_[A-Za-z0-9_-]{20,}$/.test(key);
}
