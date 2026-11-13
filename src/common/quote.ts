import { Platform } from './platform';

export function quote(s: string, platform: Platform): string {
    if (platform === Platform.Windows) {
        // For Powershell
        return `'${s.replace(/'/g, '\'\'')}'`;
    }
    return `'${s.replace(/'/g, `'\\''`)}'`;
}
