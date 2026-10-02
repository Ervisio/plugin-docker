// The plugin gets React from the console at run time; node tests only need the names to exist.
export const useEffect = () => {};
export const useSyncExternalStore = (_sub, get) => get();
export const useState = (v) => [v, () => {}];
export const useRef = (v) => ({ current: v });
export const useMemo = (f) => f();
export const useCallback = (f) => f;
