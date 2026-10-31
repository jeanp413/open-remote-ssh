import * as fs from 'fs/promises';
import * as http from 'http';
import { exists } from '../common/files';
import { parsePrompt, PromptKind } from './nativeSshParser';
import { getNativeSshSocketPath } from './nativeSshConnection';
import * as vscode from 'vscode';
import { ILogger } from '../common/logger';

async function askEntry(prompt: string): Promise<string | undefined> {
    return vscode.window.showInputBox({
        title: 'SSH Authentication',
        prompt,
        password: true,
        ignoreFocusOut: true,
    });
}

async function askHostKey(prompt: string, kind: PromptKind): Promise<string | undefined> {
    const acceptsFingerprint =
        kind === 'host-key-confirm-fp' || kind === 'host-key-retry-fp';

    const choices = acceptsFingerprint
        ? ['yes', 'no', 'Enter fingerprint…']
        : ['yes', 'no'];

    const choice = await vscode.window.showQuickPick(choices, {
        title: 'SSH Host Key Verification',
        placeHolder: prompt,
        ignoreFocusOut: true,
    });

    if (choice === 'Enter fingerprint…') {
        return vscode.window.showInputBox({
            title: 'SSH Host Key Fingerprint',
            prompt: 'Paste the expected host key fingerprint',
            ignoreFocusOut: true,
        });
    }

    return choice;
}

export class AskPassServer {
    private server!: http.Server;
    private _socketPath!: string;
    private closed = false;

    private constructor(
        private logger: ILogger
    ) { }

    public get socketPath() : string {
        return this._socketPath;
    }

    private async initialize(
        socketPath: string
    ): Promise<void> {
        this._socketPath = socketPath;
        this.server = http.createServer((req, res) => {
            req.setEncoding('utf8');
            if (req.method === 'POST' && req.url === '/prompt') {
                this.handleNativeSshPromptRequest(req, res)
                    .catch(err => {
                        const message = err instanceof Error ? err.message : String(err);
                        this.logger.error(`Askpass server error: ${message}`);
                    }) ;
                return;
            }

            res.statusCode = 404;
            res.end();
        });

        const server = this.server;
        server.setTimeout(300_000);

        return new Promise((resolve, reject) => {
            const handleError = (error: Error) => {
                server.removeListener('listening', handleListening);
                reject(error);
            };
            const handleListening = async () => {
                server.removeListener('error', handleError);
                try {
                    if (process.platform !== 'win32') {
                        fs.chmod(socketPath, 0o600);
                    }
                } catch (error: unknown) {
                    server.close();
                    reject(error instanceof Error ? error : new Error(String(error)));
                    return;
                }
                resolve();
            };

            server.once('error', handleError);
            server.once('listening', handleListening);
            server.listen(socketPath);
        });
    }

    private async handleNativeSshPromptRequest(req: http.IncomingMessage, res: http.ServerResponse) {
        await new Promise<void>((resolve, reject) => {
            let body = '';
            req.on('data', (chunk: Buffer | string) => {
                body += chunk.toString();
            });
            req.on('end', async () => {
                try {
                    const parsed = JSON.parse(body) as { prompt: string };
                    if (typeof parsed.prompt !== 'string') {
                        throw new Error('Malformed askpass request');
                    }

                    const parsedPrompt = parsePrompt(parsed.prompt);

                    const response = parsedPrompt.kind === 'entry'
                        ? await askEntry(parsedPrompt.message)
                        : await askHostKey(parsedPrompt.message, parsedPrompt.kind);

                    const cancelled = response === undefined;

                    res.statusCode = 200;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({
                        response,
                        cancelled
                    }));
                    resolve();
                } catch (err) {
                    res.statusCode = 500;
                    res.end();
                    reject(err);
                }
            });
        });
    }

    static async create(logger:ILogger): Promise<AskPassServer> {
        const socketPath = getNativeSshSocketPath('askpass');
        const askpassServer = new AskPassServer(logger);
        await askpassServer.initialize(socketPath);
        return askpassServer;
    }

    async dispose() {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.server.close();
        if (process.platform !== 'win32' && await exists(this.socketPath)) {
            await fs.unlink(this.socketPath);
        }
    }
}
