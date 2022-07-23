export default class SSHDestination {
    constructor(
        public readonly hostname: string,
        public readonly user?: string,
        public readonly port?: number
    ) {
    }

    static parse(dest: string): SSHDestination {
        let user: string | undefined;
        const atPos = dest.lastIndexOf('@');
        if (atPos !== -1) {
            user = dest.substring(0, atPos);
        }

        let port: number | undefined;
        const colonPos = dest.lastIndexOf(':');
        if (colonPos !== -1) {
            port = parseInt(dest.substring(colonPos + 1), 10);
        }

        const start = atPos !== -1 ? atPos + 1 : 0;
        const end = colonPos !== -1 ? colonPos : dest.length;
        const hostname = dest.substring(start, end);

        return new SSHDestination(hostname, user, port);
    }

    toString(): string {
        let result = this.hostname;
        if (this.user) {
            result = `${this.user}@` + result;
        }
        if (this.port) {
            result = result + `:${this.port}`;
        }
        return result;
    }
}
