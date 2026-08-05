import process from 'node:process';
import { padLeft } from '../../src/utils/pad-left';
import { toString } from '../../src/utils/to-string';

const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true' || process.env.DEBUG === 'on';

type LogLevel = 'Trace' | 'Info' | 'Error';

export class Log {
    private _messages?: {level: string; message: string}[];

     
    constructor(_name: string, track: boolean) {
        if(track) {
            this._messages = [];
        }
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
        if(DEBUG) {
            console.log(`[${level}  - ${this.now()}] ${message}`);

            if (data) {
                console.log(toString(data));
            }
        }

        if(this._messages) {
            this._messages.push({level: level.toLowerCase(), message});
        }
    }

    private now(): string {
        const now = new Date();

        return padLeft(now.getUTCHours() + '', 2, '0')
            + ':' + padLeft(now.getMinutes() + '', 2, '0')
            + ':' + padLeft(now.getUTCSeconds() + '', 2, '0') + '.' + now.getMilliseconds();
    }

    public show() {
    }

    public dispose() {
    }

    public hasInclusiveMessage(level: string, message: string): boolean {
        if(!this._messages) {
            return false;
        }

        for(const record of this._messages) {
            if(record.level === level && record.message.includes(message)) {
                return true;
            }
        }

        return false;
    }
}
