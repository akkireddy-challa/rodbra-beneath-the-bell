/// <reference types="ammojs-typed/ammo/ambient/ammo" />

declare module '*.json';

// Build-time flag injected via `define` only in the viteSingleFile publish/bundle
// configs (true). It is intentionally NOT defined in live-edit serving (dev server
// + deployed creator serve /dist raw with no transform), so reads MUST be guarded
// with `typeof __BUNDLED__ !== 'undefined'` — see game/src/utils/worldDataLoader.ts.
declare const __BUNDLED__: boolean;

// Vite build-time env substitutions (via define in vite.config.js).
// Only the keys we actually read from source are declared here.
interface ImportMetaEnv {
  readonly VITE_GAME_SERVER_PORT?: string;
  readonly VITE_GAME_PLAY_AGENT_PORT?: string;
  readonly VITE_RELOAD_WATCHER_PORT?: string;
  readonly VITE_DEFAULT_RENDERER?: string;
  readonly VITE_LID_SENSOR_PORT?: string;
  readonly VITE_API_SERVER_BASE_URL?: string;
  readonly VITE_API_TOKEN?: string;
  readonly VITE_PLAY_AUTH_URL?: string;
}

interface ImportMeta {
  // Optional because engine code is served by dev-server.cjs (plain Node HTTP),
  // which does no transformation — `import.meta.env` is undefined at runtime.
  readonly env?: ImportMetaEnv;
}

