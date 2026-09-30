/**
 * Jest mock for `three/tsl`.
 *
 * See `three-webgpu.ts` for why this is needed: `three/tsl` is ESM-only and the
 * real TSL node graph can only be built by the WebGPU renderer. These stubs
 * satisfy the top-level import bindings of engine material factories, and model
 * just enough of the real nodes' two load-bearing behaviours for tests that DO
 * take the WebGPU branch (`setActiveRendererType('webgpu')`):
 *
 *  - every call returns a FRESH node object, so a test can assert that two
 *    materials built independent graphs rather than sharing one, and
 *  - a node records the operand nodes it was built from (`inputs`) plus a
 *    single-owner build stack, so `buildGraph()` below reproduces the real
 *    failure a shared node causes: `THREE.TSL: TypeError: Cannot read properties
 *    of undefined (reading 'addToStack')`.
 *
 * Add exports here only as tested modules begin importing more `three/tsl`
 * symbols.
 */

/** A node's identity plus the operands it was built from. The real TSL nodes carry
 *  per-build builder state of exactly this shape; `buildGraph` walks it. */
export interface MockNode {
    /** Operand nodes this one was constructed from — the graph edges. */
    inputs: MockNode[];
    /** The graph root that claimed this node on its first build. A second, different
     *  root reaching the same node is the bug this mock exists to catch. */
    owner: MockNode | undefined;
    [key: string]: unknown;
}

/** A chainable no-op node: every math method returns another chainable node, and
 *  swizzles (`.rgb`) return one too, so expressions like
 *  `diffuseColor.rgb.mul(attribute('emissive','float')).mul(3)` are inert.
 *  `inputs` records which nodes it was derived from. */
function chainableNode(inputs: unknown[] = []): MockNode {
    const node = {
        inputs: inputs.filter(isMockNode),
        owner: undefined,
    } as MockNode;
    const derive = (...args: unknown[]): MockNode => chainableNode([node, ...args]);
    for (const m of ['mul', 'add', 'sub', 'div', 'lessThan', 'greaterThan', 'toVar', 'assign']) {
        node[m] = derive;
    }
    for (const swizzle of ['rgb', 'xyz', 'r', 'g', 'b', 'a']) {
        node[swizzle] = node;
    }
    return node;
}

function isMockNode(value: unknown): value is MockNode {
    return typeof value === 'object' && value !== null && Array.isArray((value as MockNode).inputs);
}

/**
 * Stand-in for a material build: walk an opacity/emissive node graph the way the
 * real node builder does, claiming each node for this graph.
 *
 * A node the real builder finds already bound into ANOTHER material's graph has no
 * builder stack of its own to add to — that is the `addToStack` TypeError WebGPU
 * games hit when hundreds of faded scenery materials build. Re-building the SAME
 * graph is fine (a material recompiles on every renderer/shader-cache change), so
 * only a second distinct owner throws.
 */
export function buildGraph(root: unknown): void {
    if (!isMockNode(root)) return;
    const walk = (node: MockNode): void => {
        if (node.owner !== undefined && node.owner !== root) {
            throw new TypeError("THREE.TSL: Cannot read properties of undefined (reading 'addToStack')");
        }
        node.owner = root;
        for (const input of node.inputs) walk(input);
    };
    walk(root);
}

export function attribute(_name: string, _type?: string): unknown {
    return chainableNode();
}

export function float(_value: number): unknown {
    return chainableNode();
}

/** The accumulated diffuse-colour (albedo) node — a chainable stub here. */
export const diffuseColor: unknown = chainableNode();

/** A uniform node: chainable, with a settable `.value` (env fade band writes it;
 *  ColorGradeState holds Vector3/Color values). */
export function uniform(value: unknown): unknown {
    const node = chainableNode();
    node.value = value;
    return node;
}

/** View-space position node — `.length()` returns a chainable node. */
export const positionView: { length: () => unknown } = { length: () => chainableNode() };

export function smoothstep(a: unknown, b: unknown, x: unknown): unknown {
    return chainableNode([a, b, x]);
}

export function oneMinus(x: unknown): unknown {
    return chainableNode([x]);
}
