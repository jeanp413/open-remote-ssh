## GSSAPI / Kerberos authentication

Hosts that authenticate with GSSAPI (for example Kerberos-joined machines) are supported through your local SSH client.
When the entry for a host in your SSH config requests GSSAPI:

```
Host k8s-dev
    HostName k8s-dev.example.com
    GSSAPIAuthentication yes
```

the extension connects by delegating to the `ssh` binary installed on your machine instead of its built-in SSH library, because the Kerberos credentials can only be obtained through the platform's GSSAPI implementation. Your own `ssh_config` keeps working as usual in this mode, including `GSSAPIDelegateCredentials`, `ProxyJump`, `ProxyCommand`, and `ForwardAgent`.

Notes on this mode:

- Make sure a valid ticket exists before connecting (`kinit`), or use `ssh-agent` for key-based fallback.
- Connections are multiplexed through an SSH ControlMaster, so authentication happens once. OpenSSH on Windows does not support multiplexing, so each operation there opens its own connection.
- The connection runs non-interactively: there are no password prompts. Unknown host keys must already be trusted (present in `known_hosts` or covered by `StrictHostKeyChecking accept-new` in your config).
