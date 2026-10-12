// Minimal stdio<->TCP relay, the shape of a real `ProxyCommand` helper:
// `netcat`, `cloudflared access ssh`, `coder ssh --stdio`, `aws ssm` all do
// this. Invoked as `node.exe <this file> <host> <port>`.
//
// Kept as .cjs: the repo gitignores `**/*.js`, and an explicit CommonJS
// extension runs under `node` untranspiled. Deliberately dependency-free.

'use strict';

const net = require('node:net');

const host = process.argv[2];
const port = Number(process.argv[3]);

if (!host || !Number.isInteger(port)) {
    process.stderr.write(`usage: relay.cjs <host> <port>\n`);
    process.exit(2);
}

const socket = net.connect(port, host);

socket.on('error', (error) => {
    process.stderr.write(`relay: ${error.message}\n`);
    process.exit(1);
});

socket.on('connect', () => {
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
});

socket.on('close', () => {
    process.exit(0);
});
