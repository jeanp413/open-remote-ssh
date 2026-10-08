import { runDocker } from './run-docker';

export function getMappedPort(name: string): number {
    const portOutput = runDocker(['port', name, '2222/tcp']);

    const match = portOutput.match(/:(\d+)\s*$/m);

    if(!match) {
        throw new Error(`Unable to parse mapped port from output: ${portOutput}`);
    }

    return Number.parseInt(match[1], 10);
}
