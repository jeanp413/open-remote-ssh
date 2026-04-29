# Native SSH Connection Mode

## Requirements

- Add a new opt-in setting that lets users choose the connection backend used by Open Remote - SSH.
- Preserve the current `ssh2` implementation as the default behavior.
- Add a native OpenSSH backend that uses the user's installed `ssh` executable for authentication and transport, with reuse owned by the extension helper HTTP server.
- Let multiple VS Code windows connected to the same SSH authority reuse one authenticated native SSH connection through the shared helper without prompting again.
- Surface native SSH password, passphrase, keyboard-interactive, and host-key prompts through VS Code UI by combining OpenSSH askpass integration with prompt parsing from native `ssh` output.
- Share reusable connection information through the extension global storage directory so independent extension host processes can discover the same connection.
- Keep the existing user-facing connection flow, remote authority format, host tree commands, server installation behavior, and resolved authority result shape.
- Support the existing server installation path by providing the operations currently used by `installCodeServer`: command execution, partial-output command execution, tunnel creation, and cleanup.
- Continue supporting dynamic forwarding for port forwarding when enabled.
- Provide useful logs for backend selection, helper discovery, native SSH process startup, reuse, stale registry cleanup, and tunnel failures.

## Constraints

- Do not replace the current `ssh2` backend. Native SSH must be additive and gated by configuration.
- The native backend cannot handle interactive prompts directly through `ssh2` callbacks. Authentication, host-key verification, passphrase prompts, password prompts, and platform-specific SSH behavior should be delegated to the native `ssh` process and the user's SSH configuration.
- Native SSH prompts must not block on an invisible terminal. Every native `ssh` process that can authenticate must be launched with an askpass environment and monitored for output prompts so questions can be routed back to the helper and then to VS Code UI.
- The extension should not persist credentials, private keys, passwords, passphrases, or SSH agent details in global storage.
- Global storage data must be treated as coordination metadata only. Store local control endpoint details, process identity, authority keys, timestamps, and non-secret connection facts.
- HTTP control endpoints must bind to loopback only and require an unguessable per-helper token from the registry.
- Do not use OpenSSH ControlMaster, ControlPath, or ControlPersist. Multiplexing and reuse must be the role of the helper HTTP server.
- Registry files may be stale because VS Code windows and helper processes can exit independently. Every reuse path must validate liveness before trusting registry entries.
- The current codebase has no test directory, so initial verification should rely on TypeScript compilation plus focused manual extension-host testing unless tests are introduced as part of the implementation.
- `rg` is unavailable in the current workspace; repository inspection used `find`/`grep` fallback.

## Current Architecture

- `src/extension.ts` registers `RemoteSSHResolver` as the resolver for `ssh-remote` authorities.
- `src/authResolver.ts` owns the end-to-end resolve flow:
  - parse the encoded SSH destination;
  - read `remote.SSH.*` settings;
  - load SSH config with `SSHConfiguration`;
  - create `SSHConnection` instances using `ssh2`;
  - authenticate with `ssh2` callbacks;
  - run `installCodeServer`;
  - open a tunnel to the remote VS Code server;
  - return `new vscode.ResolvedAuthority('127.0.0.1', localPort, connectionToken)`.
- `src/ssh/sshConnection.ts` is the practical connection contract used by the resolver and server setup code:
  - `connect()`;
  - `exec()`;
  - `execPartial()`;
  - `forwardOut()`;
  - `addTunnel()`;
  - `closeTunnel()`;
  - `close()`.
- `src/serverSetup.ts` is backend-independent except for its concrete `SSHConnection` type annotation. It runs shell commands and parses the install script output.

## Local Helper Design Patterns

The native SSH mode should use these helper-process patterns:

- A long-lived helper process owning a native `ssh` child is a viable model.
- The helper should receive a structured startup configuration and use it to spawn native `ssh` with explicit command and argument arrays.
- A local HTTP management surface is consistent with the requested architecture, but it must be authenticated, loopback-only, schema-validated, and body-size-limited.
- The helper must own piped `ssh.stdin` so it can write command envelopes, cleanup scripts, and approved prompt responses.
- The helper should coordinate discovery through a registry entry and remove that entry on clean shutdown.
- The helper should use explicit keepalive or lease renewal, but multi-window attachment must be lease-based so one closing window does not disconnect other windows.
- The helper should clean up the management server, SSH child processes, local tunnel servers, generated askpass wrapper, and registry data on exit.
- The helper may suppress or route noisy SSH output after setup completes, but it must use per-command unique sentinels and robust stdout/stderr framing rather than broad text markers.
- Platform-specific command spawning behavior, especially Windows `.bat` and `.cmd` wrappers, must be handled centrally.
- Logs must redact sensitive SSH arguments, bearer tokens, prompt responses, and command payloads that may contain secrets.

## Proposed Setting

Add an application-scoped setting:

- `remote.SSH.connectionBackend`
- Type: string enum
- Default: `"ssh2"`
- Values:
  - `"ssh2"`: current in-process `ssh2` backend.
  - `"native"`: use native OpenSSH helper and shared connection registry.

Optional follow-up settings, if needed during implementation:

- `remote.SSH.nativeSshPath`: explicit path to `ssh`, default empty for PATH lookup.

Keep the first implementation minimal by adding only `connectionBackend` unless path discovery proves too brittle.

## Proposed Architecture

### 1. Connection Backend Abstraction

Introduce an interface for the connection operations the resolver actually needs, for example `RemoteSSHConnection`:

- `connect(): Promise<void>`
- `exec(command: string, params?: string[], options?: unknown): Promise<{ stdout: string; stderr: string }>`
- `execPartial(command: string, tester: (stdout: string, stderr: string) => boolean, params?: string[], options?: unknown): Promise<{ stdout: string; stderr: string }>`
- `addTunnel(config: SSHTunnelConfig): Promise<SSHTunnelConfig & { server?: net.Server }>`
- `closeTunnel(name?: string): Promise<void>`
- `close(): Promise<void>`

Refactor `installCodeServer` to accept this interface instead of the concrete `SSHConnection` class.

Keep the existing `src/ssh/sshConnection.ts` as the `ssh2` implementation of that interface.

### 2. Native Helper Process

Add a small Node-based helper entrypoint bundled with the extension, for example:

- `src/native/nativeSshServer.ts`
- `src/native/nativeSshClient.ts`
- `src/native/nativeSshConnection.ts`
- `src/native/nativeSshRegistry.ts`
- `src/native/askpass/askpass.js`

The helper process should:

- bind an HTTP server to `127.0.0.1` on an OS-assigned port;
- generate a random bearer token at startup;
- start and supervise native `ssh` child processes for one normalized SSH authority;
- own the reusable connection lifecycle so additional VS Code windows attach to the helper instead of creating their own authenticated transport;
- maintain an attached extension-host event channel so prompts detected by helper-owned `ssh` processes can be surfaced by the active VS Code window;
- expose loopback-only authenticated endpoints for:
  - health checks;
  - command execution;
  - partial command execution with streamed stdout/stderr parsing;
  - opening or closing local tunnels;
  - askpass prompt requests from native `ssh`;
  - parsed prompt requests detected from native `ssh` stdout/stderr;
  - returning connection metadata needed by the resolver;
  - graceful shutdown, if no windows remain attached.

The extension host should communicate with the helper through `NativeSshClient`, not by reaching into helper internals.

The helper API should be explicit and versioned. Minimum endpoints:

- `GET /health`: validate the helper is alive and matches the expected authority/backend schema.
- `POST /attach`: register an extension-host lease and open an event stream for prompts/status.
- `POST /detach`: release an extension-host lease.
- `POST /exec`: run a command and return stdout/stderr/exit status.
- `POST /exec-partial`: run a command and resolve when the current `execPartial` tester condition is satisfied.
- `POST /tunnel/open`: open or reuse a local tunnel for a remote port or socket path.
- `POST /tunnel/close`: release a tunnel lease.
- `POST /askpass`: receive prompt requests from the askpass script.

Use newline-delimited JSON, Server-Sent Events, long polling, or an equivalent simple stream for helper-to-extension-host events. A one-shot request/response API is not enough because prompt requests can happen while `connect()`, `exec()`, or tunnel startup is blocked inside a native `ssh` child process.

### 3. Helper Startup Handshake

The extension host needs a deterministic way to start a helper and know when it is safe to attach or publish registry metadata.

- Spawn the helper with `child_process.fork` or `spawn(process.execPath, [helperEntry, configPath])`, depending on what works after webpack bundling.
- Pass startup configuration through a temporary JSON file or stdin instead of a giant command-line JSON blob if the config can exceed Windows command-line limits.
- Startup configuration should include schema version, normalized authority key, ssh executable path, ssh argument array, global storage paths, requested transport features, log routing mode, and a bootstrap token.
- The helper should bind its HTTP server first, then emit a ready message to stdout or an IPC channel containing only non-secret endpoint metadata.
- The extension should call `/health` before writing or trusting the registry entry.
- Registry writes should happen after the helper is reachable, so other windows do not attach to a half-started helper.
- If helper startup times out, the extension should kill the helper process, remove temporary files, and report a clear native-mode failure.
- The helper should report startup failures as structured errors where possible, including missing `ssh`, invalid askpass wrapper, bind failure, and native SSH authentication failure.

### 4. Native SSH Prompt Bridge

The native backend must support two prompt paths for all helper-owned `ssh` processes that may need authentication:

- `SSH_ASKPASS` for prompts OpenSSH routes through askpass.
- stdout/stderr prompt parsing for prompts OpenSSH writes directly to the process output, such as host trust confirmation.

#### Askpass

- Bundle or generate a small JavaScript askpass script, for example `askpass.js`.
- Launch `ssh` with environment variables:
  - `SSH_ASKPASS=<path to askpass.js>`;
  - `SSH_ASKPASS_REQUIRE=force` where supported;
  - `DISPLAY` set to a harmless value on Unix-like platforms when OpenSSH requires it to invoke askpass;
  - helper endpoint metadata such as askpass URL and one-time request token.
- On Windows, verify whether bundled OpenSSH honors `SSH_ASKPASS`; if it does not, document the limitation and keep password-based native mode unsupported on that platform until an equivalent prompt mechanism is available.
- The askpass script should:
  - receive the OpenSSH prompt text from argv;
  - call the helper HTTP endpoint over loopback with the prompt text and one-time token;
  - print only the user response to stdout;
  - exit non-zero when the user cancels or the helper rejects the request;
  - avoid logging prompt responses.
- The helper should:
  - validate the askpass token and associate it with the pending SSH process;
  - forward the prompt to the attached extension host through `NativeSshClient`;
  - display `vscode.window.showInputBox` or a modal choice UI depending on prompt type;
  - mark password/passphrase responses as secret inputs;
  - return cancellation cleanly so OpenSSH fails rather than hanging.
- Prompt classification should be conservative:
  - passphrase/password prompts use password input boxes;
  - host-key confirmation prompts use explicit accept/cancel choices and should respect the user's SSH config;
  - unknown prompts should use password input only when OpenSSH indicates hidden input, otherwise plain input may be acceptable.
- Prompt requests must be serialized per SSH process to avoid interleaving multiple authentication questions.
- Prompt responses must never be written to global storage, output logs, command traces, or registry files.
- If no extension host is attached when a prompt is needed, the helper must fail the pending operation rather than waiting indefinitely.

#### Output Prompt Parsing

The helper must parse native `ssh` output while a process is connecting or running a command.

- Capture stdout and stderr incrementally before forwarding sanitized output to normal command handlers.
- Maintain a small rolling buffer per stream so prompts split across chunks can still be detected.
- Detect known OpenSSH prompt families, including:
  - host authenticity prompts like `Are you sure you want to continue connecting (yes/no/[fingerprint])?`;
  - changed host-key warnings that require explicit failure messaging rather than blind confirmation;
  - password prompts like `<user>@<host>'s password:`;
  - private-key passphrase prompts like `Enter passphrase for key ...:`;
  - keyboard-interactive prompts that may not go through askpass on all platforms.
- Classify prompts into UI actions:
  - host trust: show a modal VS Code warning with the host, key type, and fingerprint when present; write `yes\n` to `ssh.stdin` only if the user accepts;
  - password/passphrase: show a password input and write the response plus newline to `ssh.stdin`;
  - keyboard-interactive visible prompt: show a normal input when the prompt clearly expects visible text, otherwise use password input;
  - unrecoverable host-key mismatch: stop the process and return an actionable error instead of asking the user to bypass it.
- Ensure prompt text shown in VS Code is sanitized and bounded in length.
- Redact prompt responses and sensitive prompt context from logs.
- Add prompt timeouts and cancellation handling so a hidden or unrecognized prompt cannot hang the helper indefinitely.
- Prefer askpass when both mechanisms observe the same prompt; de-duplicate by tracking pending prompt state per process.
- Keep parsing rules centralized in a `NativeSshPromptParser` module so additional platform-specific prompt patterns can be added safely.

### 5. Command Execution Protocol

The plan cannot rely on `ssh <host> <command>` per request as the normal execution path, because that can re-authenticate and breaks the reuse goal. The helper must provide a reusable command execution protocol.

Recommended first implementation:

- Start one helper-owned persistent remote shell process per authority for setup/exec work.
- Launch it with native `ssh` using the askpass and prompt-parser environment.
- Serialize command execution over that shell. This is acceptable because server setup is already sequential and avoids multiplexing complexity.
- Wrap every command in a generated command envelope with unique begin/end sentinels.
- Capture stdout/stderr separately where possible:
  - for POSIX remotes, run a generated shell wrapper that redirects stdout and stderr through tagged streams or temporary files and prints sentinel metadata;
  - for Windows remotes, use a PowerShell wrapper that emits tagged output and exit status.
- Return `{ stdout, stderr }` to match the current `SSHConnection.exec` behavior.
- Implement `execPartial` by watching tagged output for the caller's tester condition and then draining/cleaning the command envelope safely.
- If the persistent shell dies, mark the helper unhealthy and force a reconnect path instead of silently spawning a new authenticated shell behind an attached window.
- Do not run multiple commands concurrently on the same persistent shell until a robust framing protocol exists.

Remote shell detection and command wrapping:

- Reuse the existing `remotePlatform` setting when provided.
- When platform is unknown, run a minimal detection command through the persistent shell and classify POSIX shell, PowerShell, or cmd-like behavior.
- Keep separate command envelope implementations for POSIX shell, PowerShell, and cmd if cmd support is required.
- Ensure command envelopes preserve the behavior expected by `installCodeServer`, including long heredoc-like payloads and partial output parsing.
- Include an explicit cleanup command for interrupted envelopes so a canceled `execPartial` cannot leave the shell stuck in a heredoc or multiline input state.
- If cleanup cannot guarantee shell synchronization, discard the shell and mark the helper unhealthy.

Command safety requirements:

- Avoid concatenating untrusted strings into local `ssh` command lines. Use `child_process.spawn(file, args, { shell: false })`.
- Preserve the existing install script behavior, but treat command strings as remote shell payloads and wrap them in a controlled envelope.
- Escape only for the target remote shell and keep platform-specific quoting in one module.
- Bound command output buffers, with larger limits only for known server setup commands.
- Redact prompt responses and bearer tokens before logging command envelopes or process output.

This protocol is a key missing piece because native OpenSSH without ControlMaster does not expose an API equivalent to `ssh2.exec()` for many independent channels over one authenticated connection.

### 6. Native SSH Transport Strategy

Use the helper HTTP server as the native reuse primitive. Do not use OpenSSH ControlMaster.

- For each normalized SSH authority, create or attach to one helper process recorded in global storage.
- The helper should own the persistent native SSH resources for that authority, including at least the command shell and any long-lived forwarding processes.
- The helper should eagerly create the native SSH resources needed by normal resolution during the first connection so later windows do not trigger new authentication prompts.
- The helper must launch native `ssh` with the askpass environment for initial connection and for any later child process that may authenticate.
- The helper must also attach prompt parsers to native `ssh` stdout/stderr and be able to write approved prompt responses to `ssh.stdin`.
- Command execution should be exposed as helper HTTP requests and implemented by the helper against its owned SSH transport.
- Partial command execution must preserve the current `execPartial` behavior needed by server setup: resolve when the tester matches stdout/stderr, while cleaning up safely afterward.
- Opening tunnels should be exposed as helper HTTP requests and implemented by helper-owned forwarding resources.
- TCP forwarding can be implemented with:
  - a helper-managed local proxy to a persistent native `ssh -D 127.0.0.1:<socksPort>` SOCKS process for remote TCP ports; or
  - helper-owned `ssh -N -L ...` child processes when dynamic SOCKS is disabled.
- Stream-local forwarding can be implemented with helper-owned native `ssh` forwarding processes when the local OpenSSH version and platform support it.
- Every helper-owned forwarding process must also use the askpass/prompt-parser path because it may authenticate independently from the command shell.

Important design notes:

- A plain native `ssh <host> <command>` subprocess per command would delegate authentication to OpenSSH, but would not satisfy the reuse requirement by itself.
- The helper must be the shared owner of any persistent authenticated process or forwarding process needed to avoid repeated authentication across VS Code windows.
- If OpenSSH does not expose a robust portable way to run independent exec requests over one non-ControlMaster process, the first native implementation should use a helper-owned persistent shell for install/setup commands and helper-owned tunnel subprocesses for forwarding. That limitation should be documented, and the default backend should remain `ssh2`.
- Without ControlMaster, a separate tunnel subprocess can still require authentication. The helper must either keep that process alive for reuse, route its prompts through VS Code UI, or use the persistent SOCKS process for TCP tunnels so second windows attach without prompting.

The first implementation should support:

- TCP server listening mode (`remoteServerListenOnSocket: false`);
- TCP tunnels through dynamic SOCKS or `-L`;
- ProxyJump, ProxyCommand, identity files, host aliases, and SSH-agent behavior as interpreted by native OpenSSH through the user's config.

For `remoteServerListenOnSocket: true`, prefer supporting native OpenSSH stream-local forwarding when available. If support is not reliable across platforms, fail with a clear `NotAvailable` error in native mode and document that users should use the `ssh2` backend or disable socket listening.

### 7. Askpass Packaging and Process Environment

`SSH_ASKPASS` usually needs an executable program, not only a TypeScript module inside the extension bundle.

- Generate a small askpass wrapper in the extension global storage directory at helper startup.
- On Unix-like platforms, write it with owner-only permissions and an executable bit.
- The wrapper should invoke the extension's runtime with the bundled askpass JS entrypoint and pass through the OpenSSH prompt argv.
- If the runtime executable cannot safely run the JS entrypoint, use a small shell wrapper that invokes the same Node/Electron runtime already hosting the extension.
- On Windows, verify the installed OpenSSH behavior:
  - whether it honors `SSH_ASKPASS`;
  - whether it requires a GUI subsystem executable;
  - whether stdin prompt parsing is sufficient for password/host-key prompts.
- Launch native `ssh` with no inherited terminal and with `stdio: ['pipe', 'pipe', 'pipe']` so prompts can be parsed and responses can be written through the helper.
- Avoid `BatchMode=yes` in native mode because it disables password/passphrase prompting.
- Consider setting `NumberOfPasswordPrompts=1` per process attempt to avoid repeated hidden prompt loops; retries should be controlled by the helper.
- Avoid inheriting arbitrary extension environment variables into helper-owned `ssh` children except the variables required for SSH, askpass, locale, and platform operation.

### 8. Authority Identity and Reuse Key

The registry key must avoid both accidental sharing and unnecessary duplication.

- Include the encoded remote authority target.
- Include the selected backend schema version.
- Include the configured SSH config file path and a fingerprint of the computed host configuration with sensitive values redacted.
- Include settings that affect transport shape, such as dynamic forwarding and socket-listen mode.
- Include the local platform because path and askpass behavior differ by OS.
- Do not include raw secrets, identity file contents, agent socket values, or tokens.

If the SSH config changes, the next resolver should compute a different reuse key or invalidate the old helper after a failed health/config check.

### 9. Terminal Environment and Agent Forwarding

The current resolver updates `environmentVariableCollection` with values discovered during server setup, especially for agent forwarding behavior. Native mode must preserve that behavior.

- Keep the existing `installCodeServer` environment variable flow.
- If the native SSH config uses `ForwardAgent yes`, ensure the remote server setup still reports the remote `SSH_AUTH_SOCK` value when needed.
- Update `context.environmentVariableCollection` exactly as the existing resolver does after install output is parsed.
- Do not expose local `SSH_AUTH_SOCK` or identity-agent paths in registry metadata or logs.
- Include terminal environment behavior in manual verification because terminals are a user-visible part of Remote SSH.

### 10. Remote Server Cleanup and Management

Native helper mode should account for remote cleanup operations and helper management commands.

- Add a helper endpoint for remote cleanup if the extension needs to stop or remove the remote VS Code server.
- Generate cleanup scripts using the same platform-specific logic as server setup, not ad hoc process killing in the resolver.
- Run cleanup through the persistent command execution protocol so stdout/stderr and prompts are handled consistently.
- Add a keepalive or lease-renew endpoint separate from command execution.
- Add an explicit graceful shutdown endpoint that is only honored when there are no active leases, unless the resolver is disposing the owning helper due to failure.

### 11. Security and Storage Hardening

- Create `native-ssh` storage directories with owner-only permissions where the platform supports it.
- Treat registry files as untrusted input and validate every field before use.
- Use random high-entropy bearer tokens for helper HTTP requests.
- Use separate short-lived askpass prompt tokens, scoped to one process and one prompt.
- Reject non-loopback requests and unexpected HTTP methods.
- Bound request body sizes for all helper endpoints.
- Avoid permissive CORS. The helper is not a browser API.
- Never log bearer tokens, askpass tokens, prompt responses, full environment blocks, or full command payloads when they may contain secrets.
- Rotate helper tokens when a helper restarts and remove registry entries on clean shutdown.
- On stale or suspicious registry data, delete the entry and start a new helper.

### 12. Global Storage Registry

Store registry entries in `context.globalStorageUri`, for example:

- `native-ssh/registry.json`
- `native-ssh/<authorityHash>/helper.json`
- `native-ssh/<authorityHash>/logs/...`

Each registry entry should include:

- normalized authority key;
- helper HTTP host and port;
- bearer token;
- helper PID;
- dynamic SOCKS port, when enabled;
- created and last-seen timestamps;
- extension version or registry schema version.

Do not store askpass tokens in the long-lived registry. Askpass request tokens should be short-lived and scoped to a single pending prompt or SSH process.

Use atomic writes:

- write to a temporary file;
- rename over the registry file.

Reuse algorithm:

1. Normalize the authority from `SSHDestination` and relevant config identity.
2. Read the registry.
3. Find an entry for the same normalized authority and backend version.
4. Call `/health` with the token.
5. If healthy, attach to that helper.
6. If unhealthy, remove the stale entry and start a new helper.
7. On startup races, use a lock file or retry loop so two windows do not create duplicate helpers for the same authority.

Do not store the VS Code server `connectionToken` as the primary reuse primitive unless needed. It is sensitive enough to avoid long-lived persistence. Prefer asking the helper to provide active tunnel metadata after liveness validation.

### 13. Resolver Flow in Native Mode

In `RemoteSSHResolver.resolve`:

1. Read `remote.SSH.connectionBackend`.
2. Load SSH config and calculate the same host label and install settings as today.
3. If backend is `"ssh2"`, use the current flow.
4. If backend is `"native"`:
   - create or attach to `NativeSshConnection` for the authority;
   - call `connect()` to attach to or start the helper-owned native SSH transport;
   - handle prompt requests from the helper using VS Code UI while `connect()` or command execution is pending;
   - run `installCodeServer` through the backend interface;
   - open the tunnel to `installResult.listeningOn`;
   - update terminal environment variables from install output as today;
   - register the label formatter as today;
   - return `ResolvedAuthority` with the local tunnel port and server connection token.

When attaching to an existing helper:

- verify helper schema version, authority key, transport-affecting settings, and liveness;
- renew the current window's lease;
- open a prompt/status event stream before issuing operations that may prompt;
- request or create a local tunnel for this window rather than assuming another window's local tunnel port is reusable forever.

Keep resolver-level error behavior consistent:

- show the log and retry/close dialog on first resolve attempt;
- map install-script failures to `RemoteAuthorityResolverError.NotAvailable`;
- map transient helper/native process failures to `TemporarilyNotAvailable` where retry may help.

### 14. Cleanup and Lifetime

- In `ssh2` mode, preserve current disposal semantics.
- In native mode, disposing one extension host should close only the tunnels opened for that window, not necessarily the shared helper connection.
- The helper should keep a reference count or attachment lease per window.
- Leases should expire if a window exits without cleanup.
- The helper can stop its native SSH child processes after no leases remain and an idle timeout has elapsed.
- Registry entries should be removed when the helper exits cleanly.
- Stale entries should be removed by future resolver attempts.

### 15. Failure Modes and Fallback Behavior

- If native `ssh` is not found, fail native mode with a clear error and keep `ssh2` as the default backend.
- If the helper starts but cannot create the required command shell, mark the helper unhealthy and remove its registry entry.
- If prompt parsing detects a changed host-key warning, fail with instructions to fix the user's known hosts file; do not offer an accept button.
- If the helper loses its attached extension-host event stream during a prompt, cancel the prompt and fail the pending operation.
- If a forwarded-port process exits unexpectedly, close affected local servers and surface an actionable error.
- If the persistent command shell loses framing synchronization, discard it, mark the helper unhealthy, and force a clean reconnect.
- If the helper registry says a helper is healthy but `/health` reports a mismatched schema or authority key, remove the registry entry and start a new helper.
- If remote platform detection conflicts with `remote.SSH.remotePlatform`, prefer the explicit setting and log the detected mismatch.
- Do not silently fall back from `"native"` to `"ssh2"` after a native failure; the selected backend should be explicit so behavior is debuggable.

## Implementation Steps

1. Add the `remote.SSH.connectionBackend` configuration contribution in `package.json`.
2. Define a shared connection interface and update `installCodeServer` to depend on it.
3. Adapt `RemoteSSHResolver` so the existing `ssh2` flow is isolated behind a backend creation path with no behavior change.
4. Add registry helpers for authority hashing, atomic reads/writes, liveness validation, stale cleanup, and startup locking.
5. Add security and storage primitives for owner-only directories, validated registry reads, token generation, and body-size-limited helper requests.
6. Add helper startup handshake:
   - startup config file or stdin input;
   - ready signal;
   - health validation before registry publication;
   - startup timeout and cleanup.
7. Add the native helper HTTP server with authenticated loopback endpoints and an extension-host event stream for prompt/status events.
8. Add authority identity computation using encoded destination, backend schema, redacted computed SSH config, and transport-affecting settings.
9. Add the askpass bridge:
   - bundle or generate the JavaScript askpass script;
   - generate an executable platform wrapper in global storage;
   - set `SSH_ASKPASS`, `SSH_ASKPASS_REQUIRE`, and any required display environment for native `ssh`;
   - add helper endpoint handling for prompt requests;
   - add client-side VS Code UI prompt handling;
   - ensure prompt responses are never logged or persisted.
10. Add native SSH output prompt parsing:
   - implement rolling-buffer parsing for stdout/stderr chunks;
   - detect host authenticity, password, passphrase, keyboard-interactive, and host-key mismatch messages;
   - surface parsed prompts through VS Code UI;
   - write accepted prompt responses to `ssh.stdin`;
   - fail safely on cancellation, timeout, host-key mismatch, or unknown blocking prompts.
11. Add OpenSSH process management:
   - ssh path resolution;
   - helper-owned persistent SSH resource startup;
   - no inherited terminal, piped stdio, and controlled environment;
   - command execution over the helper-owned persistent shell;
   - stdout/stderr collection and partial-output completion;
   - process exit/error logging.
12. Add the persistent command execution protocol:
   - command envelopes with unique sentinels;
   - stdout/stderr tagging or temporary-file collection;
   - exit-code parsing;
   - serialized command queue;
   - shell desynchronization detection and recovery.
13. Add remote shell detection and platform-specific command wrappers for POSIX shell, PowerShell, and cmd if required.
14. Add terminal environment and agent-forwarding integration so install output still updates `environmentVariableCollection`.
15. Add remote cleanup and helper management endpoints for keepalive, lease renewal, graceful shutdown, and optional remote server cleanup.
16. Add native tunnel support:
   - remote VS Code server TCP tunnel;
   - dynamic SOCKS reuse when `remote.SSH.enableDynamicForwarding` is true;
   - local port forwarding fallback when dynamic forwarding is false;
   - explicit handling for stream-local socket forwarding.
17. Wire native mode into resolver settings and error handling.
18. Add logging and diagnostics for backend selection, helper attach/start, SSH command failures, parsed prompt handling, tunnel allocation, prompt cancellation, and cleanup.
19. Add focused tests if a test harness is introduced; otherwise verify with compile/lint/manual extension-host scenarios.
20. Update README or changelog notes for the new setting, askpass behavior, parsed prompt behavior, no-ControlMaster design, and native-mode limitations.

## Verification Plan

- Run `npm run compile:src`.
- Run `npm run bundle:dev`.
- Run `npm run lint` if practical after implementation.
- Add unit tests or fixture-based checks for `NativeSshPromptParser` before relying only on manual testing.
- Add helper integration tests with a fake `ssh` executable that emits prompt fixtures, accepts stdin responses, and simulates command/tunnel lifecycle.
- Manual local extension-host checks:
  - default setting still uses existing `ssh2` behavior;
  - helper startup does not publish registry metadata until `/health` succeeds;
  - native mode connects to an SSH config alias;
  - password authentication prompts are displayed through VS Code UI via `SSH_ASKPASS`;
  - encrypted private-key passphrase prompts are displayed through VS Code UI via `SSH_ASKPASS`;
  - host trust prompts parsed from native `ssh` output are displayed as explicit VS Code accept/cancel UI;
  - changed host-key warnings fail with a clear error and are not auto-confirmed;
  - prompt cancellation fails the connection cleanly and does not hang the helper;
  - command execution returns separated stdout/stderr and correct exit status through the persistent shell protocol;
  - persistent shell death marks the helper unhealthy and a later resolve starts cleanly;
  - remote platform detection honors explicit `remote.SSH.remotePlatform` when set;
  - terminal environment variables are updated after native-mode server setup;
  - opening a second VS Code window for the same host reuses the helper without another authentication prompt;
  - attaching to an existing helper opens a new lease and event stream before issuing operations;
  - closing one window does not disconnect the other;
  - stale registry entries are cleaned after killing the helper process;
  - forwarded ports work with `remote.SSH.enableDynamicForwarding` enabled;
  - server installation works on a host with no existing server;
  - server reuse works on a host with an existing server;
  - failure to find `ssh` produces a clear error.

## Success Criteria

- `remote.SSH.connectionBackend: "ssh2"` behaves the same as the current extension.
- `remote.SSH.connectionBackend: "native"` uses the system `ssh` executable for the remote connection without using OpenSSH ControlMaster.
- Native `ssh` authentication and host trust prompts are surfaced through VS Code UI using the askpass bridge and parsed `ssh` output.
- Two windows opened to the same normalized SSH authority can share one authenticated native SSH helper.
- The second window can resolve the remote authority without re-entering credentials when the helper-owned native SSH transport is healthy.
- Command execution in native mode works through a reusable helper-owned transport without spawning a fresh authenticated `ssh <host> <command>` process for every request.
- Global storage contains only non-secret coordination metadata and can recover from stale entries.
- The resolver still returns a valid `ResolvedAuthority` backed by a local tunnel to the remote VS Code server.
- Port forwarding remains functional for native-mode TCP remotes.
- Errors are visible in the existing Remote - SSH output channel and are actionable.
- The implementation compiles and bundles successfully.
