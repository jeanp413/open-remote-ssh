import { isPrimitive, isRecord, isString } from '@zokugun/is-it-type';
import * as vscode from 'vscode';
import { inspect } from 'node:util';

type LogLevel = 'Trace' | 'Info' | 'Error';

export default class Log {
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

function padLeft(s: string, n: number, pad = ' ') {
	return pad.repeat(Math.max(0, n - s.length)) + s;
}

function toString(value: unknown): string {
	if (isPrimitive(value)) {
		return `${value}`;
	}
	else if (value instanceof Error) {
		return value.stack || value.message;
	}
	else if (isRecord(value)) {
		if (value.success === false && isString(value.message)) {
			return value.message;
		}
	}

	return inspect(value, { depth: null, compact: true, breakLength: Infinity });
}
