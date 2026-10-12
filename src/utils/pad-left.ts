export function padLeft(s: string, n: number, pad = ' ') {
    return pad.repeat(Math.max(0, n - s.length)) + s;
}
