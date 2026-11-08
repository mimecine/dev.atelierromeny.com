// @sveltia/cms ships type definitions, but its package.json sets "types": null,
// so TypeScript doesn't pick them up. Declares just what src/cms/previews.ts and
// src/pages/admin/index.astro use.
declare module "@sveltia/cms" {
  // Sveltia's bundled React; only the parts the previews use.
  export const React: {
    createElement: (type: unknown, props?: unknown, ...children: unknown[]) => unknown;
    useRef<T>(initial: T | null): { current: T | null };
    useState<T>(initial: T): [T, (value: T) => void];
    useEffect(effect: () => void | (() => void), deps?: unknown[]): void;
  };
  export function init(options?: { config?: unknown }): void;
  export function registerPreviewTemplate(name: string, component: unknown): void;
}
