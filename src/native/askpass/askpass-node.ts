import * as fs from 'fs';
import * as http from 'http';

const prompt = process.argv.slice(2).join(' ') || '';
const askpassSocketPath = process.env.NATIVE_SSH_ASKPASS_SOCKET || '';
const askpassOutputPath = process.env.NATIVE_SSH_ASKPASS_FILE || '';

function fail(reason: string): never {
    console.error(reason);
    process.exitCode = 1;
    process.exit();
}

if (!askpassSocketPath) { fail('NATIVE_SSH_ASKPASS_SOCKET is not set'); }
if (!askpassOutputPath) { fail('NATIVE_SSH_ASKPASS_FILE is not set'); }

const payload = JSON.stringify({ prompt });
const request = http.request({
    socketPath: askpassSocketPath,
    path: '/prompt',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
    },
}, (response) => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', (chunk: Buffer | string) => {
        body += chunk.toString();
    });
    response.on('end', () => {
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            return fail(`helper returned HTTP ${response.statusCode ?? '?'}`);
        }

        const contentType = response.headers['content-type'];
        if (!contentType || !contentType.includes('application/json')) {
            return fail(`expected JSON response, but received: ${contentType ?? 'none'}`);
        }

        let answer: { response?: string; cancelled? :boolean };
        try {
            answer = body ? JSON.parse(body) as { response?: string; cancelled? :boolean } : {};
        } catch (err) {
            return fail(`invalid JSON from helper: ${(err as Error).message}`);
        }

        if (answer.cancelled) {
            process.exit(1);
        }

        try {
            fs.writeFileSync(askpassOutputPath, answer.response + '\n', { encoding: 'utf8', mode: 0o600 });
        } catch (err) {
            return fail(`could not write answer file: ${(err as Error).message}`);
        }

        setTimeout(() => process.exit(0), 0);
    });
});

request.on('error', (err) => {
    fail(`socket error: ${err.message}`);
});

request.write(payload);
request.end();
