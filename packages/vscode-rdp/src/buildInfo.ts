declare const __RDP_BUILD_TIME__: string;

/** F5-Build identifizieren; direkte TypeScript-Tests haben keinen Bundler. */
export const BUILD_INFO = typeof __RDP_BUILD_TIME__ === 'string' ? __RDP_BUILD_TIME__ : 'unbundled-test';
