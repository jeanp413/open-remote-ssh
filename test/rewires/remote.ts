import { vi } from 'vitest';
import { fs } from '../mocks/fs';

vi.resetModules();

vi.doMock('node:fs', () => (
    {
        ...fs,
        default: fs,
    }
));
vi.doMock('node:fs/promises', () => ({ default: fs.promises }));
vi.doMock('node:os', async (importOriginal) => {
    const actual = await importOriginal();

    return {
        ...actual,
        tmpdir: () => '/tmp'
    };
});

const { getRemoteAuthority, RemoteSSHResolver } = await import('../../src/authResolver.js');

vi.unmock('node:fs');
vi.unmock('node:fs/promises');

export {
    getRemoteAuthority,
    RemoteSSHResolver,
};
