import { IDisposable, toDisposable } from './disposable';

export function timeout(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function disposableTimeout(handler: () => void, timeout = 0): IDisposable {
	const timer = setTimeout(() => {
		handler();
	}, timeout);
	const disposable = toDisposable(() => {
		clearTimeout(timer);
	});
	return disposable;
}

export class TimeoutTimer implements IDisposable {
	private _token: NodeJS.Timeout | undefined;
	private _isDisposed = false;

	constructor();
	constructor(runner: () => void, timeout: number);
	constructor(runner?: () => void, timeout?: number) {
		this._token = undefined;

		if (typeof runner === 'function' && typeof timeout === 'number') {
			this.setIfNotSet(runner, timeout);
		}
	}

	dispose(): void {
		this.cancel();
		this._isDisposed = true;
	}

	cancel(): void {
		if (this._token !== undefined) {
			clearTimeout(this._token);
			this._token = undefined;
		}
	}

	cancelAndSet(runner: () => void, timeout: number): void {
		if (this._isDisposed) {
			throw new Error(`Calling 'cancelAndSet' on a disposed TimeoutTimer`);
		}

		this.cancel();
		this._token = setTimeout(() => {
			this._token = undefined;
			runner();
		}, timeout);
	}

	setIfNotSet(runner: () => void, timeout: number): void {
		if (this._isDisposed) {
			throw new Error(`Calling 'setIfNotSet' on a disposed TimeoutTimer`);
		}

		if (this._token !== undefined) {
			// timer is already set
			return;
		}
		this._token = setTimeout(() => {
			this._token = undefined;
			runner();
		}, timeout);
	}
}
