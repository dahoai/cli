export const MAX_TEXT_CHARS = 100_000;

const TEXT_TYPE = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|yaml|x-yaml|toml|csv|x-ndjson|ndjson|jsonl|sql|graphql)|[^;]*\+(json|xml))/i;

/** No content type is treated as text; the gateway and most APIs always send one for real payloads. */
export function isTextual(contentType: string | null): boolean {
    return contentType === null || TEXT_TYPE.test(contentType.trim());
}

export function bodyForMcp(body: Uint8Array, contentType: string | null): string {
    if (body.length === 0) {
        return '(empty body)';
    }
    if (!isTextual(contentType)) {
        return `[binary body not shown: ${body.length} bytes, type ${contentType ?? 'unknown'}]`;
    }
    const text = new TextDecoder().decode(body);
    if (text.length <= MAX_TEXT_CHARS) {
        return text;
    }
    return `${text.slice(0, MAX_TEXT_CHARS)}\n\n[truncated: showing ${MAX_TEXT_CHARS} of ${text.length} characters; use the provider's filters, fields or pagination]`;
}

interface GatewayError {
    code?: string;
    details?: { connections?: unknown };
}

function gatewayError(body: Uint8Array): GatewayError {
    try {
        const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
        if (parsed && typeof parsed === 'object' && 'error' in parsed) {
            const e = (parsed as { error: unknown }).error;
            if (e && typeof e === 'object') {
                return e as GatewayError;
            }
        }
    } catch {
        // not JSON: no gateway error to read
    }
    return {};
}

/** One plain sentence telling the caller what to do next, or undefined when there is nothing specific to say. */
export function hintFor(status: number, body: Uint8Array, headers: Headers, surface: 'cli' | 'mcp'): string | undefined {
    if (status >= 200 && status < 300) {
        return undefined;
    }
    const error = gatewayError(body);
    const code = error.code;

    if (status === 401) {
        return 'The gateway rejected the API key. Check DAHO_API_KEY, or create a new key in DadConnect (https://connect.daho.ai, API keys page).';
    }
    if (status === 404 && code === 'not_connected') {
        return 'That app is not connected. Connect it in DadConnect (https://connect.daho.ai), then try again.';
    }
    if (status === 404 && code === 'unknown_app') {
        return 'There is no such app. Run "daho apps" (or the list_apps tool) and use an app value from it.';
    }
    if (status === 404 && code === 'connection_not_found') {
        return 'That connection id does not belong to you for this app. Run "daho connections" (or the list_connections tool).';
    }
    if (status === 409 && code === 'connection_required') {
        const ids = Array.isArray(error.details?.connections) ? (error.details.connections as unknown[]).map(String).join(', ') : '';
        const pick = surface === 'cli' ? 'choose one with --connection <id>' : 'ask the user which account to use, then repeat the call with the "connection" argument';
        return `There is more than one connection for this app${ids ? `: ${ids}` : ''}. Do not pick one yourself: ${pick}.`;
    }
    if (status === 429) {
        const wait = headers.get('retry-after');
        return `Too many requests${wait ? `: wait ${wait} seconds` : ': wait a moment'} (Retry-After), then slow down.`;
    }
    if (status === 413) {
        return 'The request body is over the 10 MB limit. Send less, or in parts.';
    }
    if (status === 400 && code === 'invalid_path') {
        return 'The gateway refused that path or query. Check it has no "${", no ".." segments and no backslashes.';
    }
    if (status >= 500) {
        return 'The gateway or the app failed. Before repeating a write, check with a read whether it already happened.';
    }
    if (status === 403) {
        return "The app refused the call. The connection may be missing a permission (scope): tell the user; do not retry.";
    }
    return undefined;
}
