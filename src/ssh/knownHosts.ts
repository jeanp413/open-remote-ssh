import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { untildify, exists as fileExists } from '../common/files';
import { isWindows } from '../common/platform';
import type { Log } from '../common/logger';

const HASH_MAGIC = '|1|';
const HASH_DELIM = '|';

export interface KnownHostsEntry {
    file: string;
    /** 0-based line index in `file` */
    line: number;
    /** The raw host field: comma-separated patterns, a `|1|` hash, or `[host]:port` */
    hostsPattern: string;
    keyType: string;
    keyBase64: string;
    /** Anything after the key (comments some tools write), preserved on rewrite */
    suffix?: string;
    /** The entry carries the @revoked marker: this exact key must be refused */
    revoked?: boolean;
}

export type HostKeyVerdict =
    | { status: 'match'; entry: KnownHostsEntry }
    | { status: 'unknown' }
    | { status: 'mismatch'; entry: KnownHostsEntry }
    | { status: 'revoked'; entry: KnownHostsEntry };

export interface KnownHosts {
    entries: KnownHostsEntry[];
    /** The file new keys get appended to; undefined when UserKnownHostsFile is `none` */
    userFile?: string;
    /** All user files, to tell user entries from global ones */
    userFiles: string[];
    /** Files that exist but could not be read — the trust store is incomplete */
    readFailures: string[];
}

export interface KnownHostsFilesConfig {
    UserKnownHostsFile?: string | string[];
    GlobalKnownHostsFile?: string | string[];
    HostKeyAlias?: string;
}

function defaultUserFiles(): string[] {
    return [
        path.join(os.homedir(), '.ssh', 'known_hosts'),
        path.join(os.homedir(), '.ssh', 'known_hosts2'),
    ];
}

function defaultGlobalFiles(): string[] {
    if (isWindows) {
        return [path.resolve(process.env.ALLUSERSPROFILE || 'C:\\ProgramData', 'ssh\\ssh_known_hosts')];
    }
    return ['/etc/ssh/ssh_known_hosts', '/etc/ssh/ssh_known_hosts2'];
}

// ssh-config's compute() already tokenizes multi-value directives into an
// array, so a string value is a single (possibly quoted) path — don't split it.
function configuredFiles(value: string | string[] | undefined, defaults: string[]): string[] {
    if (!value) {
        return defaults;
    }
    const values = Array.isArray(value) ? value : [value];
    return values
        .filter(v => !!v && v.toLowerCase() !== 'none')
        .map(v => untildify(v));
}

export async function loadKnownHosts(hostConfig: KnownHostsFilesConfig, logger: Log): Promise<KnownHosts> {
    const userFiles = configuredFiles(hostConfig['UserKnownHostsFile'], defaultUserFiles());
    const globalFiles = configuredFiles(hostConfig['GlobalKnownHostsFile'], defaultGlobalFiles());

    const entries: KnownHostsEntry[] = [];
    const readFailures: string[] = [];
    for (const file of [...userFiles, ...globalFiles]) {
        if (!await fileExists(file)) {
            continue;
        }
        try {
            const content = await fs.promises.readFile(file, 'utf8');
            const lines = content.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line || line.startsWith('#')) {
                    continue;
                }
                const parts = line.split(/\s+/);
                let revoked = false;
                if (parts[0].startsWith('@')) {
                    // @cert-authority needs certificate support in ssh2 and is
                    // not supported yet; @revoked is honored
                    if (parts[0] !== '@revoked') {
                        continue;
                    }
                    revoked = true;
                    parts.shift();
                }
                if (parts.length < 3) {
                    continue;
                }
                entries.push({
                    file,
                    line: i,
                    hostsPattern: parts[0],
                    keyType: parts[1],
                    keyBase64: parts[2],
                    suffix: parts.length > 3 ? parts.slice(3).join(' ') : undefined,
                    revoked,
                });
            }
        } catch (e) {
            // The file exists but couldn't be read: recorded keys may be
            // missing, so the caller must not treat 'unknown' as trustworthy
            logger.error(`Error reading known hosts file ${file}`, e);
            readFailures.push(file);
        }
    }

    return { entries, userFile: userFiles[0], userFiles, readFailures };
}

/**
 * The names a host may be recorded under. OpenSSH lowercases the hostname
 * before any lookup or write; when HostKeyAlias is set it is used instead of
 * the name and port entirely.
 */
function hostNames(host: string, port: number, alias?: string): string[] {
    if (alias) {
        return [alias];
    }
    const name = host.toLowerCase();
    return port === 22 ? [name, `[${name}]:22`] : [`[${name}]:${port}`];
}

function recordName(host: string, port: number, alias?: string): string {
    if (alias) {
        return alias;
    }
    const name = host.toLowerCase();
    return port === 22 ? name : `[${name}]:${port}`;
}

// A hashed host field is `|1|base64(salt)|base64(HMAC-SHA1(salt, name))` and
// always denotes a single name — there's no way to tell which one without
// guessing, which is the point of HashKnownHosts.
function matchesHashedPattern(pattern: string, names: string[]): boolean {
    const [salt, hash] = pattern.substring(HASH_MAGIC.length).split(HASH_DELIM);
    if (!salt || !hash) {
        return false;
    }
    try {
        const saltBuffer = Buffer.from(salt, 'base64');
        return names.some(name => crypto.createHmac('sha1', saltBuffer).update(name).digest('base64') === hash);
    } catch {
        return false;
    }
}

function patternToRegExp(pattern: string): RegExp {
    const escaped = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
    return new RegExp(`^${escaped}$`, 'i');
}

// OpenSSH semantics: the line applies when at least one positive pattern
// matches AND no negated pattern does. A `!` match vetoes the whole line
// immediately; a line of only negations can therefore never match.
function matchesPlainPatterns(patterns: string, names: string[]): boolean {
    let matched = false;
    for (const raw of patterns.split(',')) {
        const negated = raw.startsWith('!');
        const pattern = negated ? raw.substring(1) : raw;
        if (!pattern) {
            continue;
        }
        if (names.some(name => patternToRegExp(pattern).test(name))) {
            if (negated) {
                return false;
            }
            matched = true;
        }
    }
    return matched;
}

export function matchesHost(entry: KnownHostsEntry, host: string, port: number, alias?: string): boolean {
    const names = hostNames(host, port, alias);
    return entry.hostsPattern.startsWith(HASH_MAGIC)
        ? matchesHashedPattern(entry.hostsPattern, names)
        : matchesPlainPatterns(entry.hostsPattern, names);
}

/**
 * Only entries of the same key type take part in the comparison: a host that
 * has an rsa entry but presents an ed25519 key is 'unknown' for that type,
 * not 'mismatch' — same as OpenSSH.
 */
export function matchHostKey(entries: KnownHostsEntry[], host: string, port: number, keyType: string, keyBase64: string, alias?: string): HostKeyVerdict {
    const sameType = entries.filter(entry => entry.keyType === keyType && matchesHost(entry, host, port, alias));

    // A revoked key is refused before anything else, like OpenSSH
    const revoked = sameType.find(entry => entry.revoked && entry.keyBase64 === keyBase64);
    if (revoked) {
        return { status: 'revoked', entry: revoked };
    }

    const candidates = sameType.filter(entry => !entry.revoked);
    const exact = candidates.find(entry => entry.keyBase64 === keyBase64);
    if (exact) {
        return { status: 'match', entry: exact };
    }
    if (candidates.length) {
        return { status: 'mismatch', entry: candidates[0] };
    }
    return { status: 'unknown' };
}

export async function appendHostKey(file: string, host: string, port: number, keyType: string, keyBase64: string, alias?: string): Promise<void> {
    const dir = path.dirname(file);
    if (!await fileExists(dir)) {
        await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    }

    const name = recordName(host, port, alias);
    const isNew = !await fileExists(file);

    let prefix = '';
    if (!isNew) {
        const content = await fs.promises.readFile(file, 'utf8');
        if (content.length && !content.endsWith('\n')) {
            prefix = '\n';
        }
    }

    await fs.promises.appendFile(file, `${prefix}${name} ${keyType} ${keyBase64}\n`);

    if (isNew) {
        try {
            await fs.promises.chmod(file, 0o600);
        } catch {
            // chmod is best-effort (no-op on some filesystems)
        }
    }
}

/**
 * Whether the entry's pattern denotes exactly this one host, so its key can
 * be rewritten without affecting anything else. A `|1|` hash always denotes a
 * single name; anything with commas, wildcards or negations covers more.
 */
function coversOnlyThisHost(entry: KnownHostsEntry, host: string, port: number, alias?: string): boolean {
    if (entry.hostsPattern.startsWith(HASH_MAGIC)) {
        return true;
    }
    if (/[,*?]|^!/.test(entry.hostsPattern)) {
        return false;
    }
    const pattern = entry.hostsPattern.toLowerCase();
    return hostNames(host, port, alias).some(name => name.toLowerCase() === pattern);
}

/**
 * Replaces the recorded key in place — but only when the line covers just
 * this host. Rewriting a shared or wildcard line would silently re-pin every
 * other host it names (OpenSSH never does that). Returns false when the line
 * was left alone; the caller should then record the key elsewhere.
 */
export async function replaceHostKey(entry: KnownHostsEntry, host: string, port: number, keyBase64: string, alias?: string): Promise<boolean> {
    if (!coversOnlyThisHost(entry, host, port, alias)) {
        return false;
    }

    const content = await fs.promises.readFile(entry.file, 'utf8');
    const newline = content.includes('\r\n') ? '\r\n' : '\n';
    const lines = content.split(/\r?\n/);

    // Only replace the line if it still holds exactly what was parsed — this
    // guards against the file having been rewritten since the load, and as a
    // side effect refuses @revoked lines (their first token is the marker,
    // not the host pattern)
    const parts = lines[entry.line]?.trim().split(/\s+/);
    if (parts && parts[0] === entry.hostsPattern && parts[1] === entry.keyType && parts[2] === entry.keyBase64) {
        const suffix = entry.suffix ? ` ${entry.suffix}` : '';
        lines[entry.line] = `${entry.hostsPattern} ${entry.keyType} ${keyBase64}${suffix}`;
        await fs.promises.writeFile(entry.file, lines.join(newline));
        return true;
    }
    return false;
}

export function keyFingerprint(rawKey: Buffer): string {
    return `SHA256:${crypto.createHash('sha256').update(rawKey).digest('base64').replace(/=+$/, '')}`;
}

/**
 * The key blob is in SSH wire format: a uint32 length followed by the key
 * type string.
 */
export function keyTypeOf(rawKey: Buffer): string {
    try {
        const length = rawKey.readUInt32BE(0);
        if (length > 0 && length < 64 && rawKey.length >= 4 + length) {
            return rawKey.subarray(4, 4 + length).toString('latin1');
        }
    } catch {
        // fall through
    }
    return 'unknown';
}
