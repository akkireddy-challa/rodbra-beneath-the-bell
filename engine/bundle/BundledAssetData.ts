// Maps CDN URL → base64 data URL for standalone single-file builds.
//
// In standalone builds the data is injected into index.html as a
// <script type="application/json" id="bm-bundled-assets"> block by the standalone
// Vite config (scripts/generate-asset-manifest.mjs writes the JSON; the config
// injects it). The base64 payload deliberately bypasses the JS module graph so
// Rollup never parses it into an AST — that previously OOM-killed the publish pod.
//
// In every other build (dev, lite publish) the block is absent and this resolves
// to an empty map, so callers fall through to fetching the original CDN URL.
const ASSET_MAP: Map<string, string> = (() => {
    if (typeof document === 'undefined') return new Map();
    const el = document.getElementById('bm-bundled-assets');
    if (!el?.textContent) return new Map();
    return new Map(Object.entries(JSON.parse(el.textContent) as Record<string, string>));
})();

export default ASSET_MAP;
