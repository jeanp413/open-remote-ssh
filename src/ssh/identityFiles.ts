import * as os from 'os';
import * as path from 'path';
import { exists as fileExists } from '../common/files';

const homeDir = os.homedir();
const PATH_SSH_CLIENT_ID_DSA = path.join(homeDir, '.ssh', '/id_dsa');
const PATH_SSH_CLIENT_ID_ECDSA = path.join(homeDir, '.ssh', '/id_ecdsa');
const PATH_SSH_CLIENT_ID_RSA = path.join(homeDir, '.ssh', '/id_rsa');
const PATH_SSH_CLIENT_ID_ED25519 = path.join(homeDir, '.ssh', '/id_ed25519');
const PATH_SSH_CLIENT_ID_XMSS = path.join(homeDir, '.ssh', '/id_xmss');
const PATH_SSH_CLIENT_ID_ECDSA_SK = path.join(homeDir, '.ssh', '/id_ecdsa_sk');
const PATH_SSH_CLIENT_ID_ED25519_SK = path.join(homeDir, '.ssh', '/id_ed25519_sk');

export async function checkDefaultIdentityFiles(): Promise<string[]> {
    const files = [
        PATH_SSH_CLIENT_ID_DSA,
        PATH_SSH_CLIENT_ID_ECDSA,
        PATH_SSH_CLIENT_ID_RSA,
        PATH_SSH_CLIENT_ID_ED25519,
        PATH_SSH_CLIENT_ID_XMSS,
        PATH_SSH_CLIENT_ID_ECDSA_SK,
        PATH_SSH_CLIENT_ID_ED25519_SK
    ];

    const result: string[] = [];
    for (const file of files) {
        if (await fileExists(file)) {
            result.push(file);
        }
    }
    return result;
}
