import * as os from 'os';
import * as path from 'path';

const homeDir = os.homedir();
const PATH_SSH_CLIENT_ID_DSA = path.join(homeDir, '.ssh', '/id_dsa');
const PATH_SSH_CLIENT_ID_ECDSA = path.join(homeDir, '.ssh', '/id_ecdsa');
const PATH_SSH_CLIENT_ID_RSA = path.join(homeDir, '.ssh', '/id_rsa');
const PATH_SSH_CLIENT_ID_ED25519 = path.join(homeDir, '.ssh', '/id_ed25519');
const PATH_SSH_CLIENT_ID_XMSS = path.join(homeDir, '.ssh', '/id_xmss');
const PATH_SSH_CLIENT_ID_ECDSA_SK = path.join(homeDir, '.ssh', '/id_ecdsa_sk');
const PATH_SSH_CLIENT_ID_ED25519_SK = path.join(homeDir, '.ssh', '/id_ed25519_sk');

export const DEFAULT_IDENTITY_FILES: string[] = [
    PATH_SSH_CLIENT_ID_RSA,
    PATH_SSH_CLIENT_ID_ECDSA,
    PATH_SSH_CLIENT_ID_ECDSA_SK,
    PATH_SSH_CLIENT_ID_ED25519,
    PATH_SSH_CLIENT_ID_ED25519_SK,
    PATH_SSH_CLIENT_ID_XMSS,
    PATH_SSH_CLIENT_ID_DSA,
];
