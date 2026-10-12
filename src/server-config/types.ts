export type ServerVersion = 'closest' | 'latest' | 'match' | string;
export type ServerValidation = 'force' | 'skip' | 'strict';

export type IServerConfig = {
    version: string;
    commit: string;
    quality: string;
    release: string;
    serverApplicationName: string;
    serverDataFolderName: string;
    serverDownloadUrlTemplate?: string;
    serverValidation: ServerValidation;
};
