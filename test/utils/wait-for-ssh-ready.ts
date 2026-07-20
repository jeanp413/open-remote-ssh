import SSHConnection from '../../src/ssh/sshConnection';
import { sleep } from './sleep';

export async function waitForSSHReady(username: string, password: string, port: number, timeoutMs: number): Promise<void> {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
        const conn = new SSHConnection({
            host: '127.0.0.1',
            port,
            username,
            password,
            reconnect: false,
            readyTimeout: 10000,
            strictVendor: false,
        });

        try {
            await conn.connect();
            await conn.close();

            return;
        } catch {
            await sleep(1000);
        }
    }

    throw new Error('Timed out waiting for Docker SSH server to become ready');
}
