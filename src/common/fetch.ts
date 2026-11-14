import * as fs from 'fs/promises';
import { disposableTimeout, timeout } from './async';

const TOTAL_TIMEOUT_MS = 300_000;
const RETRY_BACKOFF_BASE_MS = 1_000;

function loadElectronFetch(): typeof fetch | undefined {
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		return require('electron')?.net?.fetch;
	} catch {
		// Not available.
	}
	return undefined;
}

const myFetch = loadElectronFetch() || globalThis.fetch;

export async function downloadWithRetries(
    url: string,
    destPath: string,
    signal?: AbortSignal,
    maxAttempts = 3,
): Promise<void> {
    let lastErr: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            await downloadOnce(url, destPath, signal);
            return;
        } catch (err) {
            lastErr = err;
            if (signal?.aborted) {
                throw err;
            }
            if (attempt < maxAttempts) {
                await timeout(RETRY_BACKOFF_BASE_MS * attempt);
            }
        }
    }

    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function downloadOnce(
    url: string,
    destPath: string,
    signal?: AbortSignal,
): Promise<void> {
    const controller = new AbortController();
    const timer = disposableTimeout(
        () => controller.abort(new Error(`download timed out after ${TOTAL_TIMEOUT_MS}ms`)),
        TOTAL_TIMEOUT_MS,
    );

    const forward = () => controller.abort(signal?.reason);
    if (signal?.aborted) {
        controller.abort(signal.reason);
    } else {
        signal?.addEventListener('abort', forward, { once: true });
    }

    let handle: fs.FileHandle | undefined;
    try {
        const res = await myFetch(url, {
            signal: controller.signal,
            redirect: 'follow',
            headers: {
                'Accept': '*/*',
            },
        });

        if (!res.ok) {
            throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
        }
        if (!res.body) {
            throw new Error('empty response body');
        }

        handle = await fs.open(destPath, 'w');
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
            await handle.write(chunk);
        }
    } catch (err) {
        // Don't leave a partial file behind on any failure path
        await fs.rm(destPath, { force: true }).catch(() => undefined);
        throw err;
    } finally {
        timer.dispose();
        signal?.removeEventListener('abort', forward);
        await handle?.close().catch(() => undefined);
    }
}
