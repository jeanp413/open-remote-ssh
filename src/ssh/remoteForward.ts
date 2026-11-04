export interface TCPRemoteForward {
    readonly remoteBindAddress?: string;
    readonly remotePort: number;
    readonly localHost: string;
    readonly localPort: number;
}

export class UnsupportedRemoteForwardError extends Error {
    constructor(message: string) {
        super(message);
    }
}

export class MalformedRemoteForwardError extends Error {
    constructor(message: string) {
        super(message);
    }
}

type ParsedEndpoint = {
    host: string;
    port: number;
};

const MAX_PORT = 65535;

function malformed(value: string, reason: string): never {
    throw new MalformedRemoteForwardError(`Malformed RemoteForward specification '${value}': ${reason}`);
}

function unsupported(value: string, reason: string): never {
    throw new UnsupportedRemoteForwardError(`Unsupported RemoteForward specification '${value}': ${reason}`);
}

function splitArguments(value: string): string[] {
    const args: string[] = [];
    let current = '';
    let quote: '"' | "'" | undefined;
    let escaped = false;

    for (const char of value.trim()) {
        if (escaped) {
            current += char;
            escaped = false;
            continue;
        }
        if (char === '\\') {
            escaped = true;
            continue;
        }
        if (quote) {
            if (char === quote) {
                quote = undefined;
            } else {
                current += char;
            }
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }
        if (/\s/.test(char)) {
            if (current) {
                args.push(current);
                current = '';
            }
            continue;
        }
        current += char;
    }

    if (quote) {
        malformed(value, 'unterminated quoted argument');
    }
    if (escaped) {
        malformed(value, 'trailing escape character');
    }
    if (current) {
        args.push(current);
    }

    return args;
}

function parsePort(value: string, port: string, allowZero: boolean, label: string): number {
    if (!/^\d+$/.test(port)) {
        malformed(value, `${label} must be a decimal port number`);
    }

    const parsed = Number(port);
    if (parsed > MAX_PORT || (!allowZero && parsed === 0)) {
        malformed(value, `${label} must be between ${allowZero ? 0 : 1} and ${MAX_PORT}`);
    }
    return parsed;
}

function rejectUnsupportedExpansion(value: string, endpoint: string): void {
    if (!endpoint.includes('%')) {
        return;
    }

    if (endpoint.startsWith('[')) {
        const closeBracket = endpoint.indexOf(']');
        const host = closeBracket === -1 ? endpoint.slice(1) : endpoint.slice(1, closeBracket);
        const percentOnlyInHost = closeBracket !== -1
            && !endpoint.slice(closeBracket + 1).includes('%');
        if (host.includes(':') && percentOnlyInHost) {
            return;
        }
    }

    unsupported(value, 'OpenSSH % expansion tokens are not supported');
}

function validateBracketedHost(value: string, host: string, label: string): void {
    if (!host.includes(':')) {
        if (host.includes('%')) {
            unsupported(value, 'OpenSSH % expansion tokens are not supported');
        }
        malformed(value, `${label} uses brackets but is not an IPv6 address`);
    }

    const zoneSeparator = host.indexOf('%');
    if (zoneSeparator === -1) {
        return;
    }
    if (zoneSeparator === 0 || zoneSeparator === host.length - 1 || host.indexOf('%', zoneSeparator + 1) !== -1) {
        malformed(value, `${label} has an invalid IPv6 zone identifier`);
    }

    const zone = host.slice(zoneSeparator + 1);
    if (/\s|\[|\]/.test(zone)) {
        malformed(value, `${label} has an invalid IPv6 zone identifier`);
    }
}

function parseBracketedEndpoint(value: string, endpoint: string, allowZero: boolean, label: string): ParsedEndpoint {
    const closeBracket = endpoint.indexOf(']');
    if (closeBracket === -1 || endpoint.indexOf('[', 1) !== -1 || endpoint.indexOf(']', closeBracket + 1) !== -1) {
        malformed(value, `${label} has invalid IPv6 brackets`);
    }

    const host = endpoint.slice(1, closeBracket);
    const suffix = endpoint.slice(closeBracket + 1);
    if (!suffix.startsWith(':') || suffix.length === 1) {
        malformed(value, `${label} must include a port after the bracketed IPv6 address`);
    }
    if (suffix.includes('%')) {
        unsupported(value, 'OpenSSH % expansion tokens are not supported');
    }
    if (suffix.slice(1).includes(':')) {
        malformed(value, `${label} has an invalid port`);
    }

    validateBracketedHost(value, host, label);
    return {
        host,
        port: parsePort(value, suffix.slice(1), allowZero, `${label} port`),
    };
}

function parseHostPort(value: string, endpoint: string, allowEmptyHost: boolean, allowZero: boolean, label: string): ParsedEndpoint {
    if (endpoint.startsWith('[')) {
        return parseBracketedEndpoint(value, endpoint, allowZero, label);
    }
    if (endpoint.includes('[') || endpoint.includes(']')) {
        malformed(value, `${label} has invalid IPv6 brackets`);
    }
    if (endpoint.includes('%')) {
        unsupported(value, 'OpenSSH % expansion tokens are not supported');
    }

    const separator = endpoint.lastIndexOf(':');
    if (separator === -1) {
        malformed(value, `${label} must have host:port form`);
    }

    const host = endpoint.slice(0, separator);
    const port = endpoint.slice(separator + 1);
    if (host.includes(':')) {
        malformed(value, `${label} contains an unbracketed IPv6 address`);
    }
    if (!allowEmptyHost && !host) {
        malformed(value, `${label} host must not be empty`);
    }

    return {
        host,
        port: parsePort(value, port, allowZero, `${label} port`),
    };
}

function parseRemoteListener(value: string, listener: string): { remoteBindAddress?: string; remotePort: number } {
    if (listener.includes('%') && !listener.startsWith('[')) {
        unsupported(value, 'OpenSSH % expansion tokens are not supported');
    }
    if (/^\d+$/.test(listener)) {
        return { remotePort: parsePort(value, listener, true, 'remote port') };
    }

    const parsed = parseHostPort(value, listener, true, true, 'remote listener');
    return {
        remoteBindAddress: parsed.host,
        remotePort: parsed.port,
    };
}

function looksLikeSlashEndpoint(value: string): boolean {
    return !/^(?:\.{0,2}|~)?\//.test(value) && /^.+\/\d+$/.test(value);
}

function looksLikeUnixSocket(value: string): boolean {
    return /^(?:\/|\.{1,2}\/|~\/)/.test(value)
        || (!value.includes(':') && !/^[+-]?\d+$/.test(value));
}

export function parseRemoteForward(value: string): TCPRemoteForward {
    const args = splitArguments(value);
    if (!args.length) {
        malformed(value, 'expected a remote listener and a local destination');
    }
    for (const arg of args) {
        rejectUnsupportedExpansion(value, arg);
    }

    if (args.length === 1) {
        const [listener] = args;
        if (looksLikeUnixSocket(listener)) {
            unsupported(value, 'single-argument Unix socket forwarding is not supported');
        }
        parseRemoteListener(value, listener);
        unsupported(value, 'remote dynamic TCP forwarding is not supported');
    }

    if (args.length !== 2) {
        malformed(value, 'expected exactly two arguments for static TCP forwarding');
    }

    const [listener, destination] = args;
    if (looksLikeSlashEndpoint(listener) || looksLikeSlashEndpoint(destination)) {
        unsupported(value, 'slash-delimited OpenSSH forwarding syntax is not supported');
    }
    if (looksLikeUnixSocket(listener)) {
        unsupported(value, 'remote Unix socket forwarding is not supported');
    }
    if (looksLikeUnixSocket(destination)) {
        unsupported(value, 'local Unix socket forwarding is not supported');
    }

    const remote = parseRemoteListener(value, listener);
    const local = parseHostPort(value, destination, false, false, 'local destination');
    return {
        ...remote,
        localHost: local.host,
        localPort: local.port,
    };
}
