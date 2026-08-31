const hasUsableLocalStorage = typeof window !== 'undefined'
  && typeof window.localStorage?.getItem === 'function'
  && typeof window.localStorage?.setItem === 'function';

if (typeof window !== 'undefined' && !hasUsableLocalStorage) {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
  };
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
}

/** Install deterministic browser APIs that jsdom omits but Radix and responsive components require. */
function installDomTestShims(): void {
  if (typeof window === 'undefined') return;

  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
  }

  if (typeof window.ResizeObserver !== 'function') {
    window.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  }

  if (typeof Element !== 'undefined') {
    if (typeof Element.prototype.hasPointerCapture !== 'function') {
      Element.prototype.hasPointerCapture = () => false;
    }
    if (typeof Element.prototype.releasePointerCapture !== 'function') {
      Element.prototype.releasePointerCapture = () => undefined;
    }
    if (typeof Element.prototype.scrollIntoView !== 'function') {
      Element.prototype.scrollIntoView = () => undefined;
    }
  }
}

installDomTestShims();
