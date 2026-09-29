/** A validation problem whose message is safe to show to the user or the agent (it never contains the key). */
export class GuardError extends Error {}

const APP_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;
const TOKEN_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
// Set by the tool itself, or dangerous to let a caller choose.
const BLOCKED_HEADERS = new Set([
    'authorization',
    'proxy-authorization',
    'host',
    'cookie',
    'content-length',
    'connection',
    'transfer-encoding',
    'daho-connection',
    'upgrade',
    'te',
    'trailer',
    'expect'
]);

function hasControl(s: string): boolean {
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c < 0x20 || c === 0x7f) {
            return true;
        }
    }
    return false;
}

export function validateApp(app: string): string {
    if (!APP_RE.test(app)) {
        throw new GuardError(`"${app.slice(0, 40)}" is not a valid app name; use an app value from "daho apps"`);
    }
    return app;
}

/** A native path: one leading "/", no host, no backslash or control characters, no `${` template syntax. */
export function validateNativePath(path: string): string {
    if (!path.startsWith('/')) {
        throw new GuardError('the path must start with "/"; full URLs are not accepted');
    }
    if (path.startsWith('//')) {
        throw new GuardError('the path must not start with "//"');
    }
    if (path.includes('\\') || hasControl(path)) {
        throw new GuardError('the path contains a backslash or a control character');
    }
    if (path.includes('${')) {
        throw new GuardError('the path contains "${", which the gateway rejects');
    }
    return path;
}

/** MCP tools take the query separately, so a `?` or `#` in the path is a mistake. */
export function validateToolPath(path: string): string {
    validateNativePath(path);
    if (path.includes('?')) {
        throw new GuardError('put query parameters in the "query" argument, not in the path');
    }
    if (path.includes('#')) {
        throw new GuardError('the path must not contain "#"');
    }
    return path;
}

/** CLI form: `/{app}/{native path}?{query}`. */
export function splitAppPath(full: string): { app: string; rest: string; query: string } {
    validateNativePath(full);
    const q = full.indexOf('?');
    const pathPart = q === -1 ? full : full.slice(0, q);
    const query = q === -1 ? '' : full.slice(q);
    const slash = pathPart.indexOf('/', 1);
    const app = slash === -1 ? pathPart.slice(1) : pathPart.slice(1, slash);
    const rest = slash === -1 ? '' : pathPart.slice(slash);
    if (rest.startsWith('//')) {
        throw new GuardError('the path must not contain "//" right after the app name');
    }
    return { app: validateApp(app), rest, query };
}

export type Scalar = string | number | boolean;

export function buildQuery(query: Record<string, Scalar | Scalar[] | null | undefined> | undefined): string {
    if (!query) {
        return '';
    }
    const pairs: string[] = [];
    for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) {
            continue;
        }
        for (const v of Array.isArray(value) ? value : [value]) {
            const text = String(v);
            if (hasControl(key) || hasControl(text) || key.includes('${') || text.includes('${')) {
                throw new GuardError(`query parameter "${key.slice(0, 40)}" contains a control character or "\${"`);
            }
            pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(text)}`);
        }
    }
    return pairs.length > 0 ? `?${pairs.join('&')}` : '';
}

export function checkHeaders(headers: Record<string, string> | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers ?? {})) {
        if (!TOKEN_RE.test(name)) {
            throw new GuardError(`"${name.slice(0, 40)}" is not a valid header name`);
        }
        if (BLOCKED_HEADERS.has(name.toLowerCase())) {
            throw new GuardError(`the ${name} header is set by the tool and cannot be overridden`);
        }
        if (hasControl(value)) {
            throw new GuardError(`the value of the ${name} header contains a control character`);
        }
        out[name] = value;
    }
    return out;
}

export function parseHeaderArg(arg: string): [string, string] {
    const i = arg.indexOf(':');
    if (i < 1) {
        throw new GuardError(`header "${arg.slice(0, 40)}" must look like "Name: value"`);
    }
    return [arg.slice(0, i).trim(), arg.slice(i + 1).trim()];
}

export function validateConnection(id: string): string {
    if (id.length === 0 || id.length > 255 || hasControl(id) || /\s/.test(id)) {
        throw new GuardError('the connection id is not valid; copy one from "daho connections"');
    }
    return id;
}

export function validateMethod<T extends string>(method: string, allowed: readonly T[]): T {
    const m = method.toUpperCase();
    if (!(allowed as readonly string[]).includes(m)) {
        throw new GuardError(`the method must be one of ${allowed.join(', ')}`);
    }
    return m as T;
}
