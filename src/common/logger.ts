import * as vscode from 'vscode';
import { padLeft } from '../utils/pad-left';
import { toString } from '../utils/to-string';

type LogLevel = 'Trace' | 'Info' | 'Error';

export class Log {
    private output: vscode.OutputChannel;

    constructor(name: string) {
        this.output = vscode.window.createOutputChannel(name);
    }

    public trace(message: string, data?: unknown): void {
        this.logLevel('Trace', message, data);
    }

    public info(message: string, data?: unknown): void {
        this.logLevel('Info', message, data);
    }

    public error(message: string, data?: unknown): void {
        this.logLevel('Error', message, data);
    }

    public logLevel(level: LogLevel, message: string, data?: unknown): void {
        this.output.appendLine(`[${level}  - ${this.now()}] ${message}`);
        if (data) {
            this.output.appendLine(toString(data));
        }
    }

    private now(): string {
        const now = new Date();
        return padLeft(now.getUTCHours() + '', 2, '0')
            + ':' + padLeft(now.getMinutes() + '', 2, '0')
            + ':' + padLeft(now.getUTCSeconds() + '', 2, '0') + '.' + now.getMilliseconds();
    }

    public show() {
        this.output.show();
    }

    public dispose() {
        this.output.dispose();
    }
}
