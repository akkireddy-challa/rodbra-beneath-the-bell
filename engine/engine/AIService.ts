/**
 * AIService — Runtime AI model access for game template code.
 *
 * Templates call `AIService.callModel(prompt)` to get a text completion.
 * By default the request is proxied through the game-play-agent so the backend
 * (cloud API) is transparent to game code.
 *
 * Local-model opt-in (developers only): set a `bmLocalAI` localStorage flag in
 * the browser and `callModel` will route to a local OpenAI-compatible server
 * (Ollama / LM Studio / llama.cpp / etc.) instead of the proxy, falling back to
 * the proxy if the local server isn't reachable. See `resolveLocalAIConfig`.
 *
 * In-browser-model opt-in (developers only): set a `bmWebLLM` localStorage flag
 * and `callModel` will run an LLM entirely in the browser via web-llm
 * (https://github.com/mlc-ai/web-llm) — no server, no API key. Requires WebGPU;
 * model weights download (multi-GB) on first use and are cached by the browser.
 *   localStorage.bmWebLLM = '1'                                  // default model
 *   localStorage.bmWebLLM = '{"model":"Llama-3.2-1B-Instruct-q4f16_1-MLC","maxTokens":512}'
 * Vision works (default model is the Phi-3.5-vision VLM) but accuracy is modest.
 * To fit a single image's embedding into the model's baked-in prefill chunk
 * (2048), images are letterboxed to 3:2 before sending — see `letterboxImageForWebLLM`.
 * The library is lazy-loaded from a CDN only when the flag is set, so it never
 * affects ordinary visitors. Falls back to the proxy when WebGPU is unavailable or
 * the engine fails to load. See `resolveWebLLMConfig` / `loadWebLLMEngine`.
 *
 * Precedence when more than one is set: `bmWebLLM` → `bmLocalAI` → proxy.
 *
 * Configuration is loaded from world.json `runtimeAI` section.
 * Per-call options override the config defaults.
 *
 * Which game-server each call reaches is not fixed: `runtimeBackend.ts` picks
 * between a local one and the deployed one per feature, so a game served over
 * plain http with no game-server running (a `bitmagic dev` project) still gets
 * chat, images, meshes, transcription and decisions.
 *
 * `decide` is the one call that is NOT an LLM: a decision model answers typed
 * questions about a state with probabilities (see `engine/DecisionTypes.ts`).
 * It never routes through the local-model opt-ins above — nothing in-browser
 * or in Ollama speaks that contract.
 */

import { resolveRuntimeBackendUrl } from 'engine/runtimeBackend.js';
import { RuntimeAIBackoffError, isBackoffStatus, readRetryAfterMs } from 'engine/RuntimeAIErrors.js';
import type { RuntimeAIConfig } from 'types/game.js';
import type {
  DecisionOptions,
  DecisionQuestion,
  DecisionsResult,
  DecisionsUsage,
  DecisionAnswers,
} from 'engine/DecisionTypes.js';

export interface AIModelOptions {
  /** System prompt prepended to the conversation. */
  systemPrompt?: string;
  /** Maximum tokens to generate. */
  maxTokens?: number;
  /** Sampling temperature (0 = deterministic, higher = more creative). */
  temperature?: number;
  /** Timeout in milliseconds. */
  timeoutMs?: number;
  /** Enable model thinking/reasoning (slower but higher quality). */
  think?: boolean;
  /** Use streaming on proxy→model connection. */
  stream?: boolean;
  /** Images to include with the prompt (base64 data-URIs or URLs). Requires a vision-capable model. */
  images?: string[];
}

export interface AIModelResponse {
  text: string;
  model: string;
  provider: string;
}

export interface ImageGenerationOptions {
  /** Image width in pixels (default 512). */
  width?: number;
  /** Image height in pixels (default 512). */
  height?: number;
  /** Timeout in milliseconds (default 120000). */
  timeoutMs?: number;
}

export interface MeshGenerationOptions {
  /** Timeout in milliseconds (default 180000). */
  timeoutMs?: number;
}

export interface TranscriptionOptions {
  /** ISO 639-1 language hint (e.g. 'en'). Omit for auto-detect. */
  language?: string;
  /** Timeout in milliseconds (default 30000). */
  timeoutMs?: number;
}

export interface TranscriptionResult {
  text: string;
  /** Detected (or hinted) ISO 639-1 language code, when the backend reports one. */
  language?: string;
}

const DEFAULT_CONFIG: Required<RuntimeAIConfig> = {
  defaultSystemPrompt: '',
  defaultTemperature: 0.7,
  defaultMaxTokens: 150,
  timeoutMs: 30_000,
  think: false,
  stream: true,
};

/** Opt-in local OpenAI-compatible model server, configured per-browser via localStorage. */
interface LocalAIConfig {
  baseUrl: string;
  /** Model id to send. When null, the first model reported by /v1/models is used. */
  model: string | null;
  maxTokens: number;
}

const LOCAL_AI_FLAG_KEY = 'bmLocalAI';
const DEFAULT_LOCAL_AI: LocalAIConfig = {
  baseUrl: 'http://localhost:11434',
  model: null,
  maxTokens: 1024,
};

/** Opt-in in-browser model via web-llm (WebGPU), configured per-browser via localStorage. */
interface WebLLMConfig {
  /** web-llm prebuilt model id. */
  model: string;
  maxTokens: number;
}

const WEB_LLM_FLAG_KEY = 'bmWebLLM';
const WEB_LLM_CDN_URL = 'https://esm.run/@mlc-ai/web-llm';
const DEFAULT_WEB_LLM: WebLLMConfig = {
  // web-llm's only prebuilt vision model (~4 GB VRAM, 4096-token context). Accuracy
  // is modest, but it runs in-browser. Images must be letterboxed to 3:2 first so the
  // per-image embedding fits the model's prefill chunk — see WEB_LLM_VISION_* below.
  model: 'Phi-3.5-vision-instruct-q4f16_1-MLC',
  maxTokens: 1024,
};

// Phi-3.5-vision's compiled WASM bakes prefill_chunk_size = 2048 (read from model
// metadata, NOT overridable), and a single image's embedding can't be split across
// prefill chunks — exceed 2048 and it throws PrefillChunkSizeSmallerThanImageError.
// The embedding size is a function only of the crop GRID (cropH·12·(cropW·12+1)+157),
// which the HD transform derives from the image's ASPECT RATIO (num_crops is hardcoded
// at 16, so pixel size is irrelevant). A square image hits the worst-case 4×4 grid =
// 2509 tokens and overflows; a 3:2 image lands on 4×3 = 12 crops = 1921 tokens, safely
// under 2048. So we letterbox every image onto a 3:2 canvas before sending.
const WEB_LLM_VISION_W = 1344; // 4×336
const WEB_LLM_VISION_H = 896; //  → 3:2 ratio → 4×3 crops (1921 tokens)

/**
 * Minimal structural types for the dynamically-imported web-llm module. The
 * package isn't a build-time dependency (it's loaded from a CDN only when the
 * flag is set), so there are no real types — we describe just what we call.
 */
interface WebLLMEngine {
  chat: {
    completions: {
      create(req: unknown): Promise<OpenAIChatCompletion>;
    };
  };
}
interface WebLLMModule {
  CreateMLCEngine(
    model: string,
    opts: { initProgressCallback?: (p: { text?: string }) => void },
  ): Promise<WebLLMEngine>;
}

/** OpenAI-compatible chat message; content is either plain text or multimodal parts. */
type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };
type ChatMessage = { role: string; content: string | ChatContentPart[] };

/** OpenAI-compatible chat completion response (only the fields we read). */
type OpenAIChatCompletion = { choices?: Array<{ message?: { content?: string } }> };

export class AIService {
  private static instance: AIService | null = null;
  private config: Required<RuntimeAIConfig>;
  private gameId: string = '';
  private localModelProbe: Promise<string | null> | null = null;
  private localAIConfig: LocalAIConfig | null | undefined;
  private webLLMConfig: WebLLMConfig | null | undefined;
  private webLLMEnginePromise: Promise<WebLLMEngine | null> | null = null;

  private constructor() {
    this.config = { ...DEFAULT_CONFIG };
  }

  /** Extract the assistant message text from an OpenAI-compatible chat completion. */
  private static completionText(data: OpenAIChatCompletion): string {
    return data.choices?.[0]?.message?.content ?? '';
  }

  /** Resolve the system prompt: per-call override, else the config default (undefined when empty). */
  private resolveSystemPrompt(options: AIModelOptions | undefined): string | undefined {
    return options?.systemPrompt ?? (this.config.defaultSystemPrompt || undefined);
  }

  /** Clamp the requested max tokens (per-call override or config default) to the provider cap. */
  private resolveMaxTokens(options: AIModelOptions | undefined, cap: number): number {
    return Math.min(options?.maxTokens ?? this.config.defaultMaxTokens, cap);
  }

  /** Run `fn` with an abort signal that fires after `timeoutMs`, always clearing the timer. */
  private async withTimeout<T>(timeoutMs: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fn(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * POST a JSON body and return the parsed JSON response, throwing
   * `<errorLabel> (status): body` on failure — as a `RuntimeAIBackoffError`
   * carrying `retryAfterMs` when the server said "later" (429/503), so a caller
   * pacing itself can stop asking for exactly that long.
   */
  private async postJSON<T>(url: string, body: unknown, signal: AbortSignal, errorLabel: string): Promise<T> {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'unknown error');
      const message = `${errorLabel} (${response.status}): ${errorBody}`;
      if (isBackoffStatus(response.status)) {
        throw new RuntimeAIBackoffError(response.status, readRetryAfterMs(errorBody), message);
      }
      throw new Error(message);
    }
    return (await response.json()) as T;
  }

  /**
   * POST a FormData body and return the parsed JSON response. No Content-Type
   * header — the browser sets the multipart boundary itself.
   */
  private async postForm<T>(url: string, form: FormData, signal: AbortSignal, errorLabel: string): Promise<T> {
    const response = await fetch(url, { method: 'POST', body: form, signal });
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'unknown error');
      throw new Error(`${errorLabel} (${response.status}): ${errorBody}`);
    }
    return (await response.json()) as T;
  }

  /**
   * Read the opt-in local-model config from localStorage (cached after first read).
   * The feature is OFF unless a developer explicitly sets the flag in their browser:
   *   localStorage.bmLocalAI = '1'         // localhost:11434, model auto-detected from /v1/models
   *   localStorage.bmLocalAI = '{"baseUrl":"http://localhost:1234","model":"my-model"}'
   * then reload. Returns null when disabled. Because it never fires for ordinary
   * visitors, the local server's CSP/CORS/mixed-content concerns only ever affect
   * the developer who turned it on.
   */
  private getLocalAIConfig(): LocalAIConfig | null {
    if (this.localAIConfig !== undefined) return this.localAIConfig;
    this.localAIConfig = AIService.resolveLocalAIConfig();
    return this.localAIConfig;
  }

  /**
   * Read a per-browser opt-in flag from localStorage. Returns `defaults` for the
   * truthy shorthands (`1` / `true` / `on`), the result of `fromJson` for a JSON
   * object value, or null when the flag is unset, unparseable, or localStorage is
   * unavailable (sandboxed iframes / privacy modes can throw on access).
   */
  private static readOptInFlag<T>(key: string, defaults: T, fromJson: (parsed: Partial<T>) => T): T | null {
    let raw: string | null = null;
    try {
      raw = globalThis.localStorage?.getItem(key) ?? null;
    } catch {
      return null;
    }
    if (!raw) return null;

    const trimmed = raw.trim();
    if (trimmed === '1' || trimmed === 'true' || trimmed === 'on') return defaults;
    if (!trimmed.startsWith('{')) return null;

    try {
      return fromJson(JSON.parse(trimmed) as Partial<T>);
    } catch {
      return null;
    }
  }

  private static resolveLocalAIConfig(): LocalAIConfig | null {
    return AIService.readOptInFlag(LOCAL_AI_FLAG_KEY, DEFAULT_LOCAL_AI, (parsed) => ({
      baseUrl: (parsed.baseUrl ?? DEFAULT_LOCAL_AI.baseUrl).replace(/\/+$/, ''),
      model: parsed.model ?? DEFAULT_LOCAL_AI.model,
      maxTokens: parsed.maxTokens ?? DEFAULT_LOCAL_AI.maxTokens,
    }));
  }

  /** Read the opt-in web-llm config from localStorage (cached). Returns null when the flag is unset. */
  private getWebLLMConfig(): WebLLMConfig | null {
    if (this.webLLMConfig !== undefined) return this.webLLMConfig;
    this.webLLMConfig = AIService.resolveWebLLMConfig();
    return this.webLLMConfig;
  }

  private static resolveWebLLMConfig(): WebLLMConfig | null {
    return AIService.readOptInFlag(WEB_LLM_FLAG_KEY, DEFAULT_WEB_LLM, (parsed) => ({
      model: parsed.model ?? DEFAULT_WEB_LLM.model,
      maxTokens: parsed.maxTokens ?? DEFAULT_WEB_LLM.maxTokens,
    }));
  }

  /**
   * Lazy-load the web-llm engine from the CDN and create it for the configured
   * model (cached after first call so the multi-GB weights load once per session).
   * Returns null — so callModel falls back to the proxy — when WebGPU is missing
   * or the import / engine creation fails.
   */
  private loadWebLLMEngine(cfg: WebLLMConfig): Promise<WebLLMEngine | null> {
    if (!this.webLLMEnginePromise) {
      this.webLLMEnginePromise = (async () => {
        if (typeof navigator === 'undefined' || !('gpu' in navigator)) {
          console.warn('[AIService] bmWebLLM enabled but this browser has no WebGPU; using proxy');
          return null;
        }
        try {
          const mod = (await import(/* @vite-ignore */ WEB_LLM_CDN_URL)) as unknown as WebLLMModule;
          return await mod.CreateMLCEngine(cfg.model, {
            initProgressCallback: (p) => console.info('[AIService] web-llm load:', p.text ?? ''),
          });
        } catch (err) {
          console.warn(`[AIService] web-llm failed to load "${cfg.model}" (${String(err)}); using proxy`);
          return null;
        }
      })();
    }
    return this.webLLMEnginePromise;
  }

  private async callWebLLM(
    engine: WebLLMEngine,
    cfg: WebLLMConfig,
    prompt: string,
    options: AIModelOptions | undefined,
  ): Promise<AIModelResponse> {
    // Letterbox images to 3:2 so each image's embedding fits the model's prefill
    // chunk (see WEB_LLM_VISION_*). No-op for text-only calls.
    const images = options?.images ?? [];
    const callOptions = images.length > 0
      ? { ...options, images: await this.letterboxImagesForWebLLM(images) }
      : options;

    const data = await engine.chat.completions.create({
      messages: this.buildOpenAIMessages(prompt, callOptions),
      temperature: options?.temperature ?? this.config.defaultTemperature,
      max_tokens: this.resolveMaxTokens(options, cfg.maxTokens),
    });
    return {
      text: AIService.completionText(data),
      model: cfg.model,
      provider: 'web-llm',
    };
  }

  /** Letterbox each image onto a 3:2 canvas for web-llm vision (browser only). */
  private async letterboxImagesForWebLLM(images: string[]): Promise<string[]> {
    if (typeof document === 'undefined' || typeof Image === 'undefined') return images;
    return Promise.all(images.map((url) => this.letterboxImageForWebLLM(url)));
  }

  /**
   * Draw an image (data-URI or URL) centered, aspect-preserved ("contain"), onto a
   * white 3:2 canvas (WEB_LLM_VISION_W × WEB_LLM_VISION_H). The fixed 3:2 ratio forces
   * Phi-3.5-vision onto a 4×3 = 12-crop grid (1921 embed tokens < the 2048 prefill
   * chunk) regardless of the source's shape — a square source would otherwise hit the
   * 4×4 grid (2509 tokens) and overflow. Returns the original url if the image fails to
   * load or the canvas is cross-origin-tainted (toDataURL throws).
   */
  private letterboxImageForWebLLM(url: string): Promise<string> {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = WEB_LLM_VISION_W;
        canvas.height = WEB_LLM_VISION_H;
        const ctx = canvas.getContext('2d');
        if (!ctx || img.width === 0 || img.height === 0) {
          resolve(url);
          return;
        }
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        const scale = Math.min(canvas.width / img.width, canvas.height / img.height);
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        ctx.drawImage(img, Math.round((canvas.width - w) / 2), Math.round((canvas.height - h) / 2), w, h);
        try {
          const out = canvas.toDataURL('image/png');
          console.info(
            `[AIService] web-llm: letterboxed image ${img.width}×${img.height} → ${canvas.width}×${canvas.height} (3:2, 12 crops)`,
          );
          resolve(out);
        } catch {
          console.warn('[AIService] web-llm: could not transform image (cross-origin canvas); sending original — vision prefill may overflow');
          resolve(url);
        }
      };
      img.onerror = () => {
        console.warn('[AIService] web-llm: image failed to load for transform; sending original');
        resolve(url);
      };
      img.src = url;
    });
  }

  /**
   * Build OpenAI-compatible chat messages from a prompt + options. When images
   * are present the user message uses the multimodal content-part array (a text
   * part plus one image_url part per image, base64 data-URI or URL) that both
   * Ollama-style vision models and web-llm VLMs accept.
   */
  private buildOpenAIMessages(prompt: string, options: AIModelOptions | undefined): ChatMessage[] {
    const messages: ChatMessage[] = [];
    const systemPrompt = this.resolveSystemPrompt(options);
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });

    const images = options?.images ?? [];
    if (images.length > 0) {
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          ...images.map((url): ChatContentPart => ({ type: 'image_url', image_url: { url } })),
        ],
      });
    } else {
      messages.push({ role: 'user', content: prompt });
    }
    return messages;
  }

  /**
   * Resolve which model to use against the local server (cached after first call).
   * Returns the configured model if set, otherwise the first model reported by the
   * OpenAI-standard /v1/models endpoint, or null if the server is unreachable or has
   * no models — in which case callModel falls back to the proxy.
   */
  private async resolveLocalModel(cfg: LocalAIConfig): Promise<string | null> {
    if (!this.localModelProbe) {
      this.localModelProbe = (async () => {
        try {
          const res = await fetch(`${cfg.baseUrl}/v1/models`, {
            signal: AbortSignal.timeout(1500),
          });
          if (!res.ok) {
            console.warn(`[AIService] local model server ${cfg.baseUrl}/v1/models returned ${res.status}; using proxy`);
            return null;
          }
          if (cfg.model) return cfg.model;
          const data = (await res.json()) as { data?: Array<{ id?: string }> };
          const detected = data.data?.find((m) => m.id)?.id ?? null;
          if (!detected) {
            console.warn(`[AIService] local model server at ${cfg.baseUrl} reports no installed models; using proxy`);
          }
          return detected;
        } catch (err) {
          console.warn(`[AIService] local model server unreachable at ${cfg.baseUrl} (${String(err)}); using proxy`);
          return null;
        }
      })();
    }
    return this.localModelProbe;
  }

  private async callLocalModel(
    cfg: LocalAIConfig,
    model: string,
    prompt: string,
    options: AIModelOptions | undefined,
    signal: AbortSignal,
  ): Promise<AIModelResponse> {
    const data = await this.postJSON<OpenAIChatCompletion>(
      `${cfg.baseUrl}/v1/chat/completions`,
      {
        model,
        messages: this.buildOpenAIMessages(prompt, options),
        temperature: options?.temperature ?? this.config.defaultTemperature,
        max_tokens: this.resolveMaxTokens(options, cfg.maxTokens),
      },
      signal,
      'local AI request failed',
    );
    return {
      text: AIService.completionText(data),
      model,
      provider: 'local',
    };
  }

  static getInstance(): AIService {
    if (!AIService.instance) {
      AIService.instance = new AIService();
    }
    return AIService.instance;
  }

  /**
   * Apply configuration from world.json runtimeAI section.
   * Called by the engine when game data is loaded.
   */
  configure(config: RuntimeAIConfig | undefined, gameId?: string): void {
    this.config = { ...DEFAULT_CONFIG, ...config };
    if (gameId) {
      this.gameId = gameId;
    }
  }

  /** Get a snapshot of the current configuration (merged defaults + world.json). */
  getConfig(): Readonly<Required<RuntimeAIConfig>> {
    return this.config;
  }

  /** Update one or more config values at runtime. Merges with existing config. */
  setConfig(partial: RuntimeAIConfig): void {
    Object.assign(this.config, partial);
  }

  /**
   * Toggle the in-browser web-llm provider at runtime (developer dev-tool).
   * Persists the `bmWebLLM` localStorage flag so the choice survives reloads, and
   * clears the cached config + loaded engine so the next `callModel` re-resolves
   * the provider — no page reload required. Enabling uses the default model; for a
   * custom model set the JSON flag directly (see file header).
   */
  setWebLLMEnabled(enabled: boolean): void {
    try {
      if (enabled) {
        globalThis.localStorage?.setItem(WEB_LLM_FLAG_KEY, '1');
      } else {
        globalThis.localStorage?.removeItem(WEB_LLM_FLAG_KEY);
      }
    } catch {
      // localStorage unavailable (sandboxed iframe / privacy mode) — the in-memory
      // cache update below still takes effect for this session.
    }
    this.webLLMConfig = undefined;
    this.webLLMEnginePromise = null;
  }

  /**
   * Send a prompt to the runtime AI model and return the text response.
   * Per-call options override the world.json runtimeAI defaults.
   */
  async callModel(prompt: string, options?: AIModelOptions): Promise<string> {
    const timeoutMs = options?.timeoutMs ?? this.config.timeoutMs;
    return this.withTimeout(timeoutMs, async (signal) => {
      const images = options?.images ?? [];
      const hasImages = images.length > 0;
      // Opt-in in-browser model via web-llm (developer-only). Runs on WebGPU with no
      // server; weights download on first use. Handles both text and vision (images
      // are letterboxed in callWebLLM to fit the model's prefill chunk). Falls back to
      // the proxy if WebGPU is missing or the engine fails to load (loadWebLLMEngine
      // logs which).
      const webCfg = this.getWebLLMConfig();
      if (webCfg) {
        const engine = await this.loadWebLLMEngine(webCfg);
        if (engine) {
          console.info(
            `[AIService] runtime AI → web-llm "${webCfg.model}" (${hasImages ? 'vision' : 'text'})`,
          );
          return (await this.callWebLLM(engine, webCfg, prompt, options)).text;
        }
        console.warn(
          `[AIService] bmWebLLM enabled but web-llm unavailable; using proxy${hasImages ? ' (vision)' : ''}`,
        );
      }

      // Opt-in local model (developer-only). Text and vision both route here when
      // enabled; images are sent in OpenAI multimodal format (Ollama supports it for
      // vision-capable models). Falls back to the proxy only if the server is
      // unreachable or has no models (resolveLocalModel logs which).
      const localCfg = this.getLocalAIConfig();
      if (localCfg) {
        const model = await this.resolveLocalModel(localCfg);
        if (model) {
          console.info(
            `[AIService] runtime AI → local model "${model}" at ${localCfg.baseUrl} (${hasImages ? 'vision' : 'text'})`,
          );
          const result = await this.callLocalModel(localCfg, model, prompt, options, signal);
          return result.text;
        }
        console.warn(
          `[AIService] bmLocalAI enabled but no usable local model at ${localCfg.baseUrl}; using proxy${hasImages ? ' (vision)' : ''}`,
        );
      }

      const payload: Record<string, unknown> = {
        gameId: this.gameId,
        prompt,
        systemPrompt: this.resolveSystemPrompt(options),
        maxTokens: options?.maxTokens ?? this.config.defaultMaxTokens,
        temperature: options?.temperature ?? this.config.defaultTemperature,
        think: options?.think ?? this.config.think,
        stream: options?.stream ?? this.config.stream,
      };
      if (hasImages) {
        payload.images = images;
      }

      // Resolved here rather than before the timeout starts, unlike the three
      // calls below: both opt-in local paths above can answer without ever
      // reaching a game-server, and probing one they are not going to use would
      // be a request for nothing.
      const base = await resolveRuntimeBackendUrl('chat');
      const data = await this.postJSON<AIModelResponse>(
        `${base}/api/ai/chat`,
        payload,
        signal,
        'AI request failed',
      );
      return data.text;
    });
  }

  /**
   * Call the AI model and parse the response as JSON.
   * Strips markdown code fences if the model wraps its output.
   */
  async callModelJSON<T = unknown>(prompt: string, options?: AIModelOptions): Promise<T> {
    const raw = await this.callModel(prompt, options);
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    return JSON.parse(cleaned) as T;
  }

  /**
   * Generate an image from a text prompt and return the hosted URL.
   * The image is ephemeral (not persisted to the asset catalog).
   */
  async generateImage(prompt: string, options?: ImageGenerationOptions): Promise<string> {
    // Resolved before the timeout starts: the first call of a session pays a
    // /health probe, and that should not come out of the caller's budget.
    const base = await resolveRuntimeBackendUrl('imageGeneration');
    return this.withTimeout(options?.timeoutMs ?? 120_000, async (signal) => {
      const payload: Record<string, unknown> = { gameId: this.gameId, prompt };
      if (options?.width) payload.width = options.width;
      if (options?.height) payload.height = options.height;

      const data = await this.postJSON<{ url: string }>(
        `${base}/api/ai/generate-image`,
        payload,
        signal,
        'Image generation failed',
      );
      return data.url;
    });
  }

  /**
   * Transcribe recorded speech audio to text (speech-to-text). The audio blob is
   * a finished recording (e.g. from MediaRecorder), not a live stream.
   *
   * Prefer `engine.getVoiceInput()` for the full mic-capture flow — this method
   * is the network call only.
   */
  async transcribe(audio: Blob, options?: TranscriptionOptions): Promise<TranscriptionResult> {
    // Before the timeout, not inside it — see generateImage.
    const base = await resolveRuntimeBackendUrl('speechToText');
    return this.withTimeout(options?.timeoutMs ?? 30_000, async (signal) => {
      const form = new FormData();
      form.set('gameId', this.gameId);
      if (options?.language) form.set('language', options.language);
      // Name the file by its container so the server maps content type → extension.
      const extension = audio.type.split(';')[0]?.split('/')[1] || 'webm';
      form.set('audio', audio, `speech.${extension}`);

      const data = await this.postForm<TranscriptionResult>(
        `${base}/api/ai/transcribe`,
        form,
        signal,
        'Transcription failed',
      );
      return { text: data.text, language: data.language };
    });
  }

  /**
   * Generate a 3D mesh (GLB) from a text prompt and return the hosted URL.
   * The mesh is ephemeral (not persisted to the asset catalog).
   * Game code can load the GLB directly or voxelize it locally.
   *
   * **Experimental** — generation takes 30-180 seconds.
   */
  async generateMesh(prompt: string, options?: MeshGenerationOptions): Promise<string> {
    // Before the timeout, not inside it — see generateImage.
    const base = await resolveRuntimeBackendUrl('meshGeneration');
    return this.withTimeout(options?.timeoutMs ?? 180_000, async (signal) => {
      const data = await this.postJSON<{ url: string }>(
        `${base}/api/ai/generate-mesh`,
        { gameId: this.gameId, prompt },
        signal,
        'Mesh generation failed',
      );
      return data.url;
    });
  }

  /**
   * Ask a decision model typed questions about a state and get calibrated
   * probabilities back. All questions are answered in parallel against the same
   * state, so batch every question the current game tick needs into one call.
   *
   *   const { answers } = await ai.decide(
   *     { cars: [{ id: 0, gap_m: 4 }] },
   *     { car_0: choice('What should `cars[0]` do?', { proceed: null, stop: null }) },
   *   );
   *   answers.car_0.choice            // 'proceed' | 'stop'
   *   answers.car_0.probabilities.stop
   *
   * Throws on timeout and transport failure. A 429 (request rate or the game's
   * spend budget) or 503 (provider overloaded, or no provider key) arrives as a
   * `RuntimeAIBackoffError` carrying `retryAfterMs` — `DegradingPolicy` waits it
   * out on the coded fallback rather than spending its retry budget.
   */
  async decide<Q extends Record<string, DecisionQuestion>>(
    state: unknown,
    questions: Q,
    options?: DecisionOptions,
  ): Promise<DecisionsResult<Q>> {
    // Before the timeout, not inside it — see generateImage.
    const base = await resolveRuntimeBackendUrl('decisions');
    const startedAt = performance.now();
    return this.withTimeout(options?.timeoutMs ?? 3_000, async (signal) => {
      const payload: Record<string, unknown> = { gameId: this.gameId, state, questions };
      if (options?.sessionId) payload.sessionId = options.sessionId;
      const data = await this.postJSON<{ answers: DecisionAnswers<Q>; model: string; usage: DecisionsUsage }>(
        `${base}/api/ai/decide`,
        payload,
        signal,
        'Decision request failed',
      );
      return {
        answers: data.answers,
        model: data.model,
        usage: data.usage,
        latencyMs: performance.now() - startedAt,
      };
    });
  }
}
