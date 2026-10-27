import { IDisposable, toDisposable } from '../common/disposable';

export type PromptKind =
    | 'host-key-confirm'      // "Are you sure ... (yes/no)?"
    | 'host-key-confirm-fp'   // "Are you sure ... (yes/no/[fingerprint])?"
    | 'host-key-retry'        // "Please type 'yes' or 'no':"
    | 'host-key-retry-fp'     // "Please type 'yes', 'no' or the fingerprint:"
    | 'entry';                // password, passphrase, KBI, OTP, ...

export interface ParsedPrompt {
    kind: PromptKind;
    /** Prompt text exactly as ssh emitted it (shown verbatim to the user). */
    message: string;
}

function parseHostKeyPrompt(prompt: string): PromptKind | null {
    // Initial prompt with fingerprint option (OpenSSH 7.6+)
    if (/^Are you sure you want to continue connecting \(yes\/no\/\[fingerprint\]\)\?/i.test(prompt)) {
        return 'host-key-confirm-fp';
    }
    // Initial prompt (all versions)
    if (/^Are you sure you want to continue connecting \(yes\/no\)\?/i.test(prompt)) {
        return 'host-key-confirm';
    }
    // Re-prompt accepting a fingerprint
    if (/^Please type 'yes', 'no' or the fingerprint:/i.test(prompt)) {
        return 'host-key-retry-fp';
    }
    // Re-prompt, generic
    if (/^Please type 'yes' or 'no':/i.test(prompt)) {
        return 'host-key-retry';
    }
    return null;
}

export const AUTH_CONFIRMED_RE = /(?:debug\d+:\s*)?(?:Authentication succeeded|Authenticated to .* using ")/i;

export function parsePrompt(prompt: string): ParsedPrompt {
    const kind = parseHostKeyPrompt(prompt);
    if (kind) {
        return { kind, message: prompt };
    }
    return { kind: 'entry', message: prompt };
}

export interface LineParserHandlers {
    onLine?(line: string): void;
    onFlush?(partial: string): void;
    onError?(reason: string): void;
}

export class LineParser {
    private buffer = '';
    private readonly handlers = new Set<LineParserHandlers>();
    private closed = false;

    constructor(handlers?: LineParserHandlers) {
        if (handlers) {
            this.handlers.add(handlers);
        }
    }

    subscribe(handlers: LineParserHandlers): IDisposable {
        this.handlers.add(handlers);
        return toDisposable(() => this.handlers.delete(handlers));
    }

    push(chunk: string): void {
        if (this.closed) {
            return;
        }
        this.buffer += chunk;
        let idx: number;
        while ((idx = this.buffer.indexOf('\n')) !== -1) {
            const raw = this.buffer.slice(0, idx);
            this.buffer = this.buffer.slice(idx + 1);
            const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
            for (const h of this.handlers) {
                h.onLine?.(line);
            }
        }
    }

    end(reason = 'stream ended'): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        if (this.buffer.length > 0) {
            const line = this.buffer;
            this.buffer = '';
            for (const h of this.handlers) {
                h.onFlush?.(line);
            }
        }
        for (const h of this.handlers) {
            h.onError?.(reason);
        }
    }
}

export class CommandRunner {
    constructor(
        private readonly stdoutParser: LineParser,
        private readonly stderrParser: LineParser,
        private readonly write: (data: string) => Promise<void>,
    ) { }

    async run<T>(
        command: string,
        predicate: (stdout: string | undefined, stderr: string | undefined) => T | undefined,
        timeoutMs = 10_000,
    ): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            let settled = false;

            const finish = (err: Error | undefined, value?: T): void => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                stdoutSubscription.dispose();
                stderrSubscription.dispose();
                if (err) {
                    reject(err);
                } else {
                    resolve(value!);
                }
            };

            const timer = setTimeout(() => {
                finish(new Error(`command timed out after ${timeoutMs}ms: ${command}`));
            }, timeoutMs);
            timer.unref();

            const stdoutSubscription = this.stdoutParser.subscribe({
                onLine: (line) => {
                    try {
                        const value = predicate(line, undefined);
                        if (value !== undefined) {
                            finish(undefined, value);
                        }
                    } catch (e) {
                        finish(e);
                    }
                },
                onError: (reason) => finish(new Error(reason)),
            });
            const stderrSubscription = this.stderrParser.subscribe({
                onLine: (line) => {
                    try {
                        const value = predicate(line, undefined);
                        if (value !== undefined) {
                            finish(undefined, value);
                        }
                    } catch (e) {
                        finish(e);
                    }
                },
                onError: (reason) => finish(new Error(reason)),
            });

            this.write(command).catch((err) => finish(err));
        });
    }
}
