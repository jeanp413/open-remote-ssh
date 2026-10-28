import * as http from 'http';
import { ILogger } from '../common/logger';

const REQUEST_TIMEOUT_MS = 5_000;
const KEEPALIVE_INTERVAL_MS = 15_000;

interface SshClientResponse {
    statusCode: number | undefined;
    body: string;
}

export class NativeSshServerClient {
    constructor(private readonly socketPath: string) { }

    request(method: 'GET' | 'POST', route: string): Promise<SshClientResponse> {
        return new Promise((resolve, reject) => {
            const request = http.request(
                {
                    socketPath: this.socketPath,
                    path: route,
                    method,
                },
                (response) => {
                    let responseBody = '';
                    response.setEncoding('utf8');
                    response.on('data', (chunk: string) => {
                        responseBody += chunk;
                    });
                    response.on('end', () =>
                        resolve({ statusCode: response.statusCode, body: responseBody }),
                    );
                    response.on('error', reject);
                },
            );

            request.setTimeout(REQUEST_TIMEOUT_MS, () => {
                request.destroy(new Error('SSH server request timed out.'));
            });
            request.on('error', reject);
            request.end();
        });
    }

    async isHealthy(): Promise<boolean> {
        try {
            const res = await this.request('GET', '/health');
            return res.statusCode === 200;
        } catch {
            return false;
        }
    }

    async keepalive(): Promise<void> {
        const res = await this.request('POST', '/keepalive');
        if (res.statusCode !== 200) {
            throw new Error(`${res.statusCode} ${res.body}`);
        }
    }
}

export class NativeSshKeepalive {
    private timer: NodeJS.Timeout | undefined;

    constructor(
        private readonly client: NativeSshServerClient,
        private readonly logger: ILogger,
        private readonly intervalMs: number = KEEPALIVE_INTERVAL_MS,
    ) { }

    get running(): boolean {
        return this.timer !== undefined;
    }

    start(): void {
        if (this.timer) {
            return;
        }
        this.ping();
        this.timer = setInterval(() => this.ping(), this.intervalMs);
        this.timer.unref();
    }

    dispose(): void {
        if (!this.timer) {
            return;
        }
        clearInterval(this.timer);
        this.timer = undefined;
    }

    private ping(): void {
        this.client.keepalive().catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.error(`keepalive failed: ${message}`);
        });
    }
}
