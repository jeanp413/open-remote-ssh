import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

// Real-protocol behaviour of the INSTALLED ssh2 tree, pulled in through
// createRequire (ssh2 is CommonJS and its deep internals have no ESM entry) —
// this file never reimplements ssh2 code; it exercises the exact bytes
// `npm ci` put in node_modules/ssh2, the bytes the extension's SSH transport
// actually runs. The manifest/lockfile shape guards live in
// test/package-ssh2.test.ts; this file pins the two runtime properties the old
// git fork (jeanp413/ssh2@a169f62) existed for, so a silent downgrade back to
// the fork — or a fresh install that skipped scripts/patch-ssh2.js — fails
// here rather than on a live connection:
//
// 1. Terrapin (CVE-2023-48795): the client KEXINIT proposal must advertise
//    strict-kex (`kex-strict-c-v00@openssh.com`) next to `ext-info-c`. The
//    fork's proposal ended at `ext-info-c`; npm's ssh2 has carried the
//    strict-kex marker since 1.11.0.
//
// 2. ECDSA host-key verification: sigSSHToASN1 must hand OpenSSL minimal,
//    positive DER INTEGERs (the fork's "Fix sigSSHToASN1", re-applied to the
//    npm tree by scripts/patch-ssh2.js), and a truncated signature must return
//    `undefined` — never throw. The fork converted r/s before its
//    truncated-signature check, so a malformed signature escaped as a
//    TypeError from inside the handshake; the patched tree checks first and
//    fails closed, which the kex layer turns into a clean "Malformed
//    signature" disconnect.

const repoRoot = path.resolve(__dirname, '../..');
// Anchored at the root manifest so the require resolves from this repo's
// node_modules — the installed tree, not any vendored or hoisted copy.
const require = createRequire(path.join(repoRoot, 'package.json'));

/** The piece of ssh2's kex module this suite reads. */
interface KexModule {
    DEFAULT_KEXINIT_CLIENT: {
        lists: {
            kex: {
                array: string[];
            };
        };
    };
}

/** The piece of ssh2's protocol utils module this suite drives. */
interface ProtocolUtilsModule {
    sigSSHToASN1: (sig: Buffer, type: string) => Buffer | undefined;
}

const kex = require('ssh2/lib/protocol/kex.js') as KexModule;
const { sigSSHToASN1 } = require('ssh2/lib/protocol/utils.js') as ProtocolUtilsModule;

/** One SSH wire binary string: uint32 length prefix + payload. */
function sshString(value: Buffer): Buffer {
    const framed = Buffer.alloc(4 + value.length);
    framed.writeUInt32BE(value.length, 0);
    value.copy(framed, 4);
    return framed;
}

/** An ECDSA signature body as it travels on the SSH wire: string r, string s. */
function ecdsaSignatureBody(r: Buffer, s: Buffer): Buffer {
    return Buffer.concat([sshString(r), sshString(s)]);
}

describe('installed ssh2 (real protocol behaviour)', () => {
    it('is exactly the version the root manifest pins', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
            dependencies: Record<string, string>;
        };
        const manifestPin = pkg.dependencies['ssh2'];
        const installedVersion = (require('ssh2/package.json') as { version: string }).version;
        expect(installedVersion, 'node_modules/ssh2 must be reinstalled to match the manifest pin').toBe(manifestPin);
        expect(installedVersion, 'the installed version must be an exact x.y.z release').toMatch(/^\d+\.\d+\.\d+$/);
    });

    // The strict-kex marker in the CLIENT proposal is the Terrapin mitigation:
    // once offered and accepted, both peers reset sequence numbers after
    // NEWKEYS and authenticate the pre-negotiation exchange. The git fork's
    // proposal ended at `ext-info-c` — no marker — so this assertion cannot
    // pass on the fork tree: it pins the fix itself, not just a version number.
    it('the client KEXINIT proposal advertises strict-kex alongside ext-info-c', () => {
        const proposal = kex.DEFAULT_KEXINIT_CLIENT.lists.kex.array;
        expect(proposal, 'the client KEXINIT proposal must offer ext-info-c').toContain('ext-info-c');
        expect(
            proposal,
            'the client KEXINIT proposal must offer kex-strict-c-v00@openssh.com (CVE-2023-48795) — the git-fork tree cannot pass this'
        ).toContain('kex-strict-c-v00@openssh.com');
    });

    // nistp256 r/s are 32 bytes; when the top byte's high bit is set, a DER
    // INTEGER needs a 0x00 pad to stay positive — exactly the case npm's
    // unpatched ssh2 writes raw (OpenSSL then reads a negative integer and
    // verification fails) and the fork fixed via convertToMpint.
    it('converts high-bit ECDSA r/s to minimal positive DER INTEGERs', () => {
        const r = Buffer.concat([Buffer.from([0x80]), Buffer.alloc(31, 0xab)]);
        const s = Buffer.concat([Buffer.from([0x90]), Buffer.alloc(31, 0xcd)]);
        const sig = sigSSHToASN1(ecdsaSignatureBody(r, s), 'ecdsa-sha2-nistp256');

        // SEQUENCE (70 content bytes) { INTEGER (33) 0x00||r; INTEGER (33) 0x00||s }
        const expected = Buffer.concat([
            Buffer.from([0x30, 70]),
            Buffer.from([0x02, 0x21, 0x00]), r,
            Buffer.from([0x02, 0x21, 0x00]), s,
        ]);
        expect(sig, 'high-bit r/s must each gain the 0x00 positive pad (33-byte INTEGERs)').toEqual(expected);
    });

    it('strips non-significant leading zeros but keeps a semantically required one', () => {
        // r: two leading zeros before a byte with the high bit clear — both
        // dropped, that is the "minimal" half of minimal positive mpint.
        // s: a leading zero before a high byte (0x80) is significant — dropping
        // it would flip the integer's sign — so it must survive untouched.
        const r = Buffer.from([0x00, 0x00, 0x7f, 0x1c, 0x55]);
        const s = Buffer.from([0x00, 0x80, 0x33]);
        const sig = sigSSHToASN1(ecdsaSignatureBody(r, s), 'ecdsa-sha2-nistp256');

        // SEQUENCE (10 content bytes) { INTEGER 0x7f,0x1c,0x55; INTEGER 0x00,0x80,0x33 }
        const expected = Buffer.concat([
            Buffer.from([0x30, 10]),
            Buffer.from([0x02, 0x03, 0x7f, 0x1c, 0x55]),
            Buffer.from([0x02, 0x03, 0x00, 0x80, 0x33]),
        ]);
        expect(sig, 'leading zeros must be stripped (r) or kept exactly when significant (s)').toEqual(expected);
    });

    // The fork's fatal ordering: it ran convertToMpint on r/s BEFORE its
    // undefined-check, so a truncated signature threw TypeError mid-handshake.
    // The patched tree must keep the check first: return undefined, no throw.
    it.each([
        ['s declares more bytes than remain', Buffer.concat([
            sshString(Buffer.alloc(32, 0xab)),
            Buffer.from([0x00, 0x00, 0x00, 0x20]),
        ])],
        ['r declares more bytes than remain', Buffer.concat([
            Buffer.from([0x00, 0x00, 0x00, 0x20]),
            Buffer.alloc(8, 0xcd),
        ])],
        ['s\u2019s length prefix itself is cut short', sshString(Buffer.alloc(32, 0xab))],
    ] as const)('returns undefined — never throws — when %s', (_label, sig) => {
        let asn1: Buffer | undefined;
        let threw: unknown;
        try {
            asn1 = sigSSHToASN1(sig, 'ecdsa-sha2-nistp256');
        } catch (error) {
            threw = error;
        }
        expect(threw, 'a truncated signature must fail closed, not throw (the git fork threw TypeError here)').toBeUndefined();
        expect(asn1, 'a truncated signature must yield no ASN.1 output').toBeUndefined();
    });
});
