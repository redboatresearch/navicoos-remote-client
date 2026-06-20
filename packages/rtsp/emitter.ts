// Phase-B faithful port: replaces Node's `events.EventEmitter` with an
// EventTarget-backed shim exposing the surface RTSPClient uses:
//   .on / .once / .emit / .removeListener / .off / .removeAllListeners
//
// Design: we keep a parallel registry that maps each caller-supplied listener
// to the arrow-wrapper we handed to EventTarget so we can surgically remove it
// via removeEventListener. This avoids the orphaned-handler problem.

type Listener = (...args: unknown[]) => void;

interface Entry {
  listener: Listener;
  wrapper: EventListener;
}

export class EventEmitter {
  // Per-event list of {listener, wrapper} pairs (insertion order preserved).
  private readonly _registry: Map<string, Entry[]> = new Map();

  // The underlying EventTarget that drives dispatch.
  private readonly _target: EventTarget = new EventTarget();

  private _bucket(event: string): Entry[] {
    if (!this._registry.has(event)) {
      this._registry.set(event, []);
    }
    return this._registry.get(event)!;
  }

  on(event: string, listener: Listener): this {
    const wrapper: EventListener = (e: Event) => {
      listener(...(e as CustomEvent<unknown[]>).detail);
    };
    this._bucket(event).push({ listener, wrapper });
    this._target.addEventListener(event, wrapper);
    return this;
  }

  once(event: string, listener: Listener): this {
    // The wrapper removes itself from the registry on first invocation, then
    // calls the original listener. EventTarget `once: true` handles its side.
    const wrapper: EventListener = (e: Event) => {
      this._removeEntry(event, listener);
      listener(...(e as CustomEvent<unknown[]>).detail);
    };
    this._bucket(event).push({ listener, wrapper });
    this._target.addEventListener(event, wrapper, { once: true });
    return this;
  }

  emit(event: string, ...args: unknown[]): boolean {
    const bucket = this._registry.get(event);
    const hasListeners = bucket !== undefined && bucket.length > 0;
    this._target.dispatchEvent(
      new CustomEvent<unknown[]>(event, { detail: args }),
    );
    return hasListeners;
  }

  removeListener(event: string, listener: Listener): this {
    this._removeEntry(event, listener);
    return this;
  }

  /** Alias for removeListener (Node API). */
  off(event: string, listener: Listener): this {
    return this.removeListener(event, listener);
  }

  removeAllListeners(event?: string): this {
    if (event !== undefined) {
      const bucket = this._registry.get(event) ?? [];
      for (const { wrapper } of bucket) {
        this._target.removeEventListener(event, wrapper);
      }
      this._registry.delete(event);
    } else {
      for (const [ev, bucket] of this._registry) {
        for (const { wrapper } of bucket) {
          this._target.removeEventListener(ev, wrapper);
        }
      }
      this._registry.clear();
    }
    return this;
  }

  // Internal helper: remove the first entry whose .listener matches, and
  // unregister the paired wrapper from EventTarget.
  private _removeEntry(event: string, listener: Listener): void {
    const bucket = this._registry.get(event);
    if (!bucket) return;
    const idx = bucket.findIndex((e) => e.listener === listener);
    if (idx === -1) return;
    const [{ wrapper }] = bucket.splice(idx, 1);
    this._target.removeEventListener(event, wrapper);
  }
}
