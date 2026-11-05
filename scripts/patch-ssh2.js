#!/usr/bin/env node
'use strict';

// Fail-closed, idempotent patcher for the installed `ssh2` dependency.
// Wired ahead of every consumer of the installed tree: postinstall,
// `bundle` and `bundle:dev` all run it first (see package.json).
//
// Why this exists: this repo previously depended on a git fork of `ssh2`
// (jeanp413/ssh2@a169f62, self-labelled 1.14.0). The fork carried a fix npm's
// `ssh2` still lacks in 1.17.0 — `sigSSHToASN1` must convert ECDSA signature
// r/s values to minimal, positive DER INTEGERs before handing them to
// OpenSSL, else host-key verification fails whenever the high bit of `r` or
// `s` is set (fork commit a169f62, "Fix sigSSHToASN1"). But the fork applied
// `convertToMpint` BEFORE its truncated-signature check, so a malformed
// signature threw a TypeError instead of failing closed. We now depend on
// npm's `ssh2` 1.17.0 (registry resolution the npm audit gate can match) and
// re-apply that one fix here, AFTER the check, so a truncated signature
// returns `undefined` — which the kex handshake turns into a clean
// "Malformed signature" disconnect — instead of throwing.
//
// The npm tree already ships the other thing the fork was pinned for:
// Terrapin strict-kex negotiation (`kex-strict-{c,s}-v00@openssh.com`,
// since ssh2 1.11.0). This script asserts those markers are present so the
// move from the fork can never silently downgrade the transport.
//
// Safety properties:
// - Exact anchors: every replacement must match the known ssh2 1.17.0 bytes
//   exactly once; otherwise exit 1 and write NOTHING. Never guess.
// - Version pin: the installed `node_modules/ssh2/package.json` version must
//   equal the root manifest's `dependencies.ssh2` exactly (shape guard — a
//   range or drift fails here, on purpose).
// - Idempotent: the patched file carries the sentinel comment below; on a
//   re-run the script only verifies the patch is complete and exits 0.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SSH2_DIR = path.join(ROOT, 'node_modules', 'ssh2');
const SENTINEL = '// open-remote-ssh-tmux: ECDSA sigSSHToASN1 mpint patch';

function die(message) {
    console.error(`patch-ssh2: ${message}`);
    process.exit(1);
}

function countOccurrences(haystack, needle) {
    let count = 0;
    for (
        let i = haystack.indexOf(needle);
        i !== -1;
        i = haystack.indexOf(needle, i + needle.length)
    ) {
        count += 1;
    }
    return count;
}

function replaceOnce(source, from, to, label) {
    const occurrences = countOccurrences(source, from);
    if (occurrences !== 1) {
        die(`anchor for ${label} matches ${occurrences} times in `
            + 'lib/protocol/utils.js (expected exactly 1) — installed ssh2 '
            + 'does not have the expected bytes, refusing to patch');
    }
    return source.replace(from, to);
}

// (1) The installed tree must be exactly the version the root manifest pins.
let wantedVersion;
try {
    const manifest =
        JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    wantedVersion = manifest.dependencies && manifest.dependencies.ssh2;
} catch (err) {
    die(`cannot read root package.json (${err.code || err.message})`);
}
if (typeof wantedVersion !== 'string' || wantedVersion.length === 0) {
    die('root package.json has no dependencies.ssh2 pin');
}
let installedVersion;
try {
    installedVersion = JSON.parse(
        fs.readFileSync(path.join(SSH2_DIR, 'package.json'), 'utf8')
    ).version;
} catch (err) {
    die(`cannot read node_modules/ssh2/package.json `
        + `(${err.code || err.message}) — is ssh2 installed?`);
}
if (installedVersion !== wantedVersion) {
    die(`node_modules/ssh2 version ${installedVersion} does not equal the `
        + `manifest pin ${wantedVersion} — reinstall node_modules`);
}

// (2) The npm tree must advertise strict-kex on both sides; without it,
// leaving the fork would be a Terrapin regression.
let kex;
try {
    kex = fs.readFileSync(
        path.join(SSH2_DIR, 'lib', 'protocol', 'kex.js'), 'utf8'
    );
} catch (err) {
    die(`cannot read node_modules/ssh2/lib/protocol/kex.js `
        + `(${err.code || err.message})`);
}
if (!kex.includes('kex-strict-c-v00@openssh.com')
    || !kex.includes('kex-strict-s-v00@openssh.com')) {
    die('lib/protocol/kex.js does not advertise strict-kex '
        + '(kex-strict-c-v00@openssh.com / kex-strict-s-v00@openssh.com) '
        + '— refusing a tree without Terrapin protection');
}

// (3) The ECDSA sigSSHToASN1 mpint patch — idempotent via the sentinel.
let utils;
try {
    utils = fs.readFileSync(
        path.join(SSH2_DIR, 'lib', 'protocol', 'utils.js'), 'utf8'
    );
} catch (err) {
    die(`cannot read node_modules/ssh2/lib/protocol/utils.js `
        + `(${err.code || err.message})`);
}

if (utils.includes(SENTINEL)) {
    // Already patched: verify it is complete, never re-apply.
    const exported = utils.includes('\n  convertToMpint,\n};');
    const applied = utils.includes('const rMpint = convertToMpint(r);')
        && utils.includes('const sMpint = convertToMpint(s);');
    if (!exported || !applied) {
        die('sentinel present but the patch is incomplete — delete '
            + 'node_modules/ssh2 and reinstall');
    }
    console.log('patch-ssh2: already patched, convertToMpint exported and '
        + 'applied after the truncated-signature check');
    process.exit(0);
}

// Insert the fork's convertToMpint (a169f62) next to the other helpers.
utils = replaceOnce(
    utils,
    'const utilBufferParser = makeBufferParser();',
    [
        SENTINEL,
        'function convertToMpint(buf) {',
        '  const prependZeroCount = buf[0] & 0x80 ? 1 : 0;',
        '',
        '  let skipZeroCount = 0;',
        '',
        '  // Skip non-significant zeroes at the big end.',
        '  for (let i = 0; i < buf.length - 1 && buf[i] === 0; i++) {',
        '    if ((buf[i + 1] & 0x80) === 0) {',
        '      skipZeroCount++;',
        '    }',
        '  }',
        '',
        '  const newBuf = Buffer.allocUnsafe(',
        '    buf.length + prependZeroCount - skipZeroCount',
        '  );',
        '  buf.copy(newBuf, prependZeroCount, skipZeroCount, buf.length);',
        '  if (prependZeroCount) {',
        '    newBuf[0] = 0;',
        '  }',
        '  buf = newBuf;',
        '  return buf;',
        '}',
        '',
        'const utilBufferParser = makeBufferParser();',
    ].join('\n'),
    'convertToMpint insertion'
);

// Apply it to the ECDSA r/s values in sigSSHToASN1 — AFTER the
// truncated-signature check, unlike the fork, so a malformed signature
// returns undefined instead of throwing.
utils = replaceOnce(
    utils,
    [
        '        utilBufferParser.init(sig, 0);',
        '        const r = utilBufferParser.readString();',
        '        const s = utilBufferParser.readString();',
        '        utilBufferParser.clear();',
        '        if (r === undefined || s === undefined)',
        '          return;',
        '',
        '        const asnWriter = new Ber.Writer();',
        '        asnWriter.startSequence();',
        '        asnWriter.writeBuffer(r, Ber.Integer);',
        '        asnWriter.writeBuffer(s, Ber.Integer);',
        '        asnWriter.endSequence();',
        '        return asnWriter.buffer;',
    ].join('\n'),
    [
        '        utilBufferParser.init(sig, 0);',
        '        const r = utilBufferParser.readString();',
        '        const s = utilBufferParser.readString();',
        '        utilBufferParser.clear();',
        '        if (r === undefined || s === undefined)',
        '          return;',
        '        // Minimal, positive DER INTEGERs for OpenSSL (git-fork fix',
        '        // a169f62), applied only AFTER the truncated-signature check',
        '        // above so a malformed signature returns undefined instead',
        '        // of throwing inside convertToMpint.',
        '        const rMpint = convertToMpint(r);',
        '        const sMpint = convertToMpint(s);',
        '',
        '        const asnWriter = new Ber.Writer();',
        '        asnWriter.startSequence();',
        '        asnWriter.writeBuffer(rMpint, Ber.Integer);',
        '        asnWriter.writeBuffer(sMpint, Ber.Integer);',
        '        asnWriter.endSequence();',
        '        return asnWriter.buffer;',
    ].join('\n'),
    'sigSSHToASN1 ECDSA conversion'
);

// Export the helper alongside the rest of the module surface.
utils = replaceOnce(
    utils,
    [
        '    proto._cipher.encrypt(packet);',
        '    return true;',
        '  },',
        '};',
    ].join('\n'),
    [
        '    proto._cipher.encrypt(packet);',
        '    return true;',
        '  },',
        '  convertToMpint,',
        '};',
    ].join('\n'),
    'convertToMpint export'
);

const utilsPath = path.join(SSH2_DIR, 'lib', 'protocol', 'utils.js');
const tmpPath = `${utilsPath}.patching`;
fs.writeFileSync(tmpPath, utils);
fs.renameSync(tmpPath, utilsPath);
console.log('patch-ssh2: patched node_modules/ssh2/lib/protocol/utils.js '
    + '(ECDSA r/s -> minimal positive mpint, fail-closed on truncated '
    + 'signatures)');
