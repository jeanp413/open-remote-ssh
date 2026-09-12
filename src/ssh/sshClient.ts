import type { SSHTunnelConfig } from './sshConnection';

/**
 * The narrow channel surface consumed by `authResolver` (agent-forward session).
 * Structurally compatible with ssh2's `ClientChannel`, so the ssh2-backed
 * connection can return its channels directly.
 */
export interface SSHExecChannel {
    on(event: 'data', listener: (chunk: Buffer) => void): unknown;
    on(event: 'close', listener: () => void): unknown;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    removeListener(event: string, listener: (...args: any[]) => void): unknown;
    /** Close the underlying channel and release the remote session. */
    close(): void;
}

/**
 * The SSH connection surface consumed by the authority resolver and the
 * server setup flow. Implemented by the ssh2-backed `SSHConnection` and by
 * `NativeSSHConnection`, which delegates to the local `ssh` binary.
 */
export interface SSHClient {
    /** Establish the connection. Idempotent: later calls reuse the first one. */
    connect(): Promise<SSHClient>;
    /** Run a command and resolve with its complete stdout/stderr. */
    exec(cmd: string, params?: string[]): Promise<{ stdout: string; stderr: string }>;
    /** Run a command and resolve as soon as `tester` matches the streamed output. */
    execPartial(cmd: string, tester: (stdout: string, stderr: string) => boolean, params?: string[]): Promise<{ stdout: string; stderr: string }>;
    /** Start a long-lived command and expose its output stream as a channel. */
    execChannel(cmd: string): Promise<SSHExecChannel>;
    /** Open a forwarding tunnel, reusing an existing one when `name` matches. */
    addTunnel(config: SSHTunnelConfig): Promise<SSHTunnelConfig & { server: unknown }>;
    /** Close one tunnel by name, or every tunnel when omitted. */
    closeTunnel(name?: string): Promise<void>;
    /** Close the connection and every tunnel backed by it. */
    close(): Promise<void>;
}
