/**
 * Jest mock for every `three/addons/*` module (a.k.a. `three/examples/jsm/*`).
 *
 * Those files are ESM-only and are not run through the ts-jest transform (which
 * only handles `.ts`), so importing any engine module that pulls one in — e.g.
 * `NpcController` importing `three/addons/utils/SkeletonUtils.js` — otherwise
 * fails with "Cannot use import statement outside a module". Same rationale as
 * the `three/webgpu` / `three/tsl` stubs: none of the addon code paths run under
 * Jest, they only need to satisfy the top-level import bindings.
 *
 * A single recursive proxy covers all named exports (loaders, `clone`, etc.):
 * every property access, call and `new` returns the proxy again, so any accidental
 * top-level evaluation is inert instead of crashing.
 */
const handler = {
    get(_target, prop) {
        // Mark as an ES module so ts-jest's interop reads named exports off `proxy`.
        if (prop === '__esModule') return true;
        return proxy;
    },
    apply() {
        return proxy;
    },
    construct() {
        return proxy;
    },
};

const proxy = new Proxy(function stubbedThreeAddon() {}, handler);

module.exports = proxy;
