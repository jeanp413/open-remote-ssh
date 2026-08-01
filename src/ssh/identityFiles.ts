import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import type { ParsedKey } from 'ssh2-streams';
import * as ssh2 from 'ssh2';
import { untildify } from '../common/files';
import { Log } from '../common/logger';

const homeDir = os.homedir();
const PATH_SSH_CLIENT_ID_DSA = path.join(homeDir, '.ssh', '/id_dsa');
const PATH_SSH_CLIENT_ID_ECDSA = path.join(homeDir, '.ssh', '/id_ecdsa');
const PATH_SSH_CLIENT_ID_RSA = path.join(homeDir, '.ssh', '/id_rsa');
const PATH_SSH_CLIENT_ID_ED25519 = path.join(homeDir, '.ssh', '/id_ed25519');
const PATH_SSH_CLIENT_ID_XMSS = path.join(homeDir, '.ssh', '/id_xmss');
const PATH_SSH_CLIENT_ID_ECDSA_SK = path.join(homeDir, '.ssh', '/id_ecdsa_sk');
const PATH_SSH_CLIENT_ID_ED25519_SK = path.join(homeDir, '.ssh', '/id_ed25519_sk');

const DEFAULT_IDENTITY_FILES: string[] = [
    PATH_SSH_CLIENT_ID_RSA,
    PATH_SSH_CLIENT_ID_ECDSA,
    PATH_SSH_CLIENT_ID_ECDSA_SK,
    PATH_SSH_CLIENT_ID_ED25519,
    PATH_SSH_CLIENT_ID_ED25519_SK,
    PATH_SSH_CLIENT_ID_XMSS,
    PATH_SSH_CLIENT_ID_DSA,
];

export interface SSHKey {
    filename: string;
    parsedKey: ParsedKey;
    fingerprint: string;
    agentSupport?: boolean;
    isPrivate?: boolean;
}

// From https://github.com/openssh/openssh-portable/blob/acb2059febaddd71ee06c2ebf63dcf211d9ab9f2/sshconnect2.c#L1689-L1690
export async function gatherIdentityFiles(identityFiles: string[], sshAgentSock: string | undefined, identitiesOnly: boolean, logger: Log) {
    identityFiles = identityFiles.map(untildify).map(i => i.replace(/\.pub$/, ''));
    if (identityFiles.length === 0) {
        identityFiles.push(...DEFAULT_IDENTITY_FILES);
    }

    const fileKeys: SSHKey[] = []

    await Promise.allSettled(identityFiles.map(async (keyPath) => {
        const publicKeyPath = keyPath + '.pub';

        let buffer: Buffer | undefined;

        try {
            buffer = await fs.promises.readFile(publicKeyPath);
        } catch (error) {
            if (error.code !== 'ENOENT') {
                 logger.error(`Error while loading SSH key ${publicKeyPath}:`, error);
            }
        }

        if(buffer) {
            const result = ssh2.utils.parseKey(buffer);

            if (result instanceof Error || !result) {
                // .pub file exists but isn't a valid SSH key (e.g. PGP key),
                // fall back to reading the private key file directly
                logger.error(`Error while loading SSH key ${publicKeyPath}, falling back to private key file`, result ?? 'unknown error');
            } else {
                const parsedKey = Array.isArray(result) ? result[0] : result;
                const fingerprint = crypto.createHash('sha256').update(parsedKey.getPublicSSH()).digest('base64');

                fileKeys.push({
                    filename: publicKeyPath,
                    parsedKey,
                    fingerprint,
                });

                return;
            }
        }

        try {
            buffer = await fs.promises.readFile(keyPath);
        } catch (error) {
            if (error.code !== 'ENOENT') {
                 logger.error(`Error while loading SSH key ${keyPath}:`, error);
            }

            return;
        }

        const result = ssh2.utils.parseKey(buffer);

        if (result instanceof Error || !result) {
            logger.error(`Error while loading SSH key ${keyPath}:`, result);

            return;
        }

        const parsedKey = Array.isArray(result) ? result[0] : result;
        const fingerprint = crypto.createHash('sha256').update(parsedKey.getPublicSSH()).digest('base64');

        fileKeys.push({
            filename: keyPath,
            parsedKey,
            fingerprint,
            isPrivate: true,
        });
    }));

    let sshAgentParsedKeys: ParsedKey[] = [];
    try {
        if (!sshAgentSock) {
            throw new Error(`SSH_AUTH_SOCK environment variable not defined`);
        }

        sshAgentParsedKeys = await new Promise<ParsedKey[]>((resolve, reject) => {
            const sshAgent = new ssh2.OpenSSHAgent(sshAgentSock);
            sshAgent.getIdentities((err, publicKeys) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(publicKeys || []);
                }
            });
        });
    } catch (e) {
        logger.error(`Couldn't get identities from OpenSSH agent`, e);
    }

    const sshAgentKeys: SSHKey[] = sshAgentParsedKeys.map(parsedKey => {
        const fingerprint = crypto.createHash('sha256').update(parsedKey.getPublicSSH()).digest('base64');
        return {
            filename: parsedKey.comment,
            parsedKey,
            fingerprint,
            agentSupport: true
        };
    });

    const agentKeys: SSHKey[] = [];
    const preferredIdentityKeys: SSHKey[] = [];
    for (const agentKey of sshAgentKeys) {
        const foundIdx = fileKeys.findIndex(k => agentKey.parsedKey.type === k.parsedKey.type && agentKey.fingerprint === k.fingerprint);
        if (foundIdx >= 0) {
            preferredIdentityKeys.push({ ...fileKeys[foundIdx], agentSupport: true });
            fileKeys.splice(foundIdx, 1);
        } else if (!identitiesOnly) {
            agentKeys.push(agentKey);
        }
    }
    preferredIdentityKeys.push(...agentKeys);
    preferredIdentityKeys.push(...fileKeys);

    logger.trace(`Identity keys:`, preferredIdentityKeys.length ? preferredIdentityKeys.map(k => `${k.filename} ${k.parsedKey.type} SHA256:${k.fingerprint}`).join('\n') : 'None');

    return preferredIdentityKeys;
}
