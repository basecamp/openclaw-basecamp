/**
 * Root-level shim so the host's doctor-contract resolver finds the sidecar:
 * it probes `<pkg>/doctor-contract-api.js` and `<pkg>/dist/doctor-contract-api.js`,
 * and tsc (rootDir ".") emits this file as `dist/doctor-contract-api.js`.
 * The implementation lives in src/doctor-contract-api.ts.
 */
export * from "./src/doctor-contract-api.js";
