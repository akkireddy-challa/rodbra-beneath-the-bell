# Runtime AI Service

`AIService` lets game code call an LLM at runtime (NPC dialogue, procedural text, etc.) and generate images. Always call asynchronously — never block the game loop.

Every call here runs on a game-server, and the engine finds one for you: a local one when it is running and can serve that feature, the deployed one otherwise (`engine/runtimeBackend.ts`). Nothing to configure — these APIs work the same in `bitmagic dev`, in the Creator, and in a published game.

## Text Generation

```typescript
import { AIService } from 'engine/AIService.js';
const ai = AIService.getInstance(); // or this.engine.getAIService()
const text = await ai.callModel('Describe a cave.', { systemPrompt: '...', temperature: 0.7 });
const data = await ai.callModelJSON<{ items: string[] }>('List 3 items as JSON: {"items":[...]}');
```

## Image Generation

`generateImage(prompt, options?)` generates an image from a text prompt and returns a hosted URL. The image is ephemeral (not saved to the asset catalog). Use this for runtime-generated visuals like player drawings, dynamic sprites, or procedural content.

```typescript
const ai = AIService.getInstance();
const url = await ai.generateImage('A cartoon banana, transparent background');
// url is a hosted image URL that can be loaded as a texture
```

Options: `width?: number` (default 512), `height?: number` (default 512), `timeoutMs?: number` (default 120000).

To load the generated image as a Three.js texture:
```typescript
const texture = new THREE.TextureLoader().load(url);
const material = new THREE.SpriteMaterial({ map: texture, transparent: true });
const sprite = new THREE.Sprite(material);
```

## Vision (Image Recognition)

`callModel` supports vision via the `images` option — pass base64 data-URIs to have the AI analyze images:

```typescript
const label = await ai.callModel('What is in this image? One word.', {
  images: [dataUri], temperature: 0.2, maxTokens: 20
});
```

## 3D Mesh Generation (Experimental)

`generateMesh(prompt, options?)` generates a 3D GLB model from a text prompt and returns a hosted URL. Generation takes 30-180 seconds. The mesh is ephemeral (not saved to the asset catalog).

```typescript
const ai = AIService.getInstance();
const glbUrl = await ai.generateMesh('A wooden treasure chest');
```

The returned URL points to a `.glb` file. Load it with the engine's loader factory — never
`new GLTFLoader()`, which decodes no KTX2 and so cannot read a compressed texture:
```typescript
import { createGltfLoader } from 'engine/loaders/GltfLoaderSupport.js';

const gltf = await createGltfLoader().loadAsync(glbUrl);
scene.add(gltf.scene);
```

Options: `timeoutMs?: number` (default 180000).

## Decisions (typed questions, not text)

`decide(state, questions, options?)` asks a decision model (TypeSafe Jev) typed questions about a `state` and returns calibrated probabilities — no prose to parse, ~100–600 ms. Use it for NPC choices, routing, classification: anything where code needs a *decision* rather than a sentence. All questions in one call are answered in parallel against the same state, so ask everything the tick needs at once and pick what matters in code.

```typescript
import { choice, noul } from 'engine/DecisionTypes.js';
const { answers, model, usage, latencyMs } = await ai.decide(
    { cars: [{ id: 0, speed_mps: 6, ahead: { gap_m: 4, closing_mps: 2 } }] },
    {
        car_0_action: choice('What should `cars[0]` do for the next 0.5 s?', {
            proceed: 'Way is clear', slow: 'Something ahead is closing', stop: 'Brake now to avoid a collision',
        }),
        car_0_horn: noul('Should `cars[0]` sound its horn?'),
    },
);
answers.car_0_action.choice              // 'proceed' | 'slow' | 'stop' (typed from the options)
answers.car_0_action.probabilities.stop  // read probabilities, not just the winner
answers.car_0_horn.noul                  // 0..1
```

Question types: `choice` (options → probabilities + `confidence`), `noul` (yes/no probability), `score` (ordered levels → weighted score). Reference nested state with a backticked path in the instructions. Options: `timeoutMs` (default 3000), `sessionId`. Keep the state compact (round numbers, only nearby entities); the request is billed per input token.

Two limits, both per game: 300 requests a minute, and a spend budget per hour. Over either, the call throws a `RuntimeAIBackoffError` (`engine/RuntimeAIErrors.js`) carrying `retryAfterMs`. Do not retry through it — batch (never one call per NPC), and wrap the model in a `DegradingPolicy`, which waits it out on your coded fallback for you. See `@docs decision-ai.md` for the loop that does all of this.

## Configuration

Configure defaults in `world.json` under `runtimeAI`:
- `defaultSystemPrompt` — system prompt for all calls
- `defaultTemperature` — default 0.7
- `defaultMaxTokens` — default 150
- `timeoutMs` — default 30000
- `think` — default false
- `stream` — default true

Per-call options override these defaults.
