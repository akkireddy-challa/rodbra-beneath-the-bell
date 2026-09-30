// @types/three ≤0.183 depended on @webgpu/types, which is where `navigator.gpu`
// came from. 0.185 dropped that dependency, so the engine names it directly —
// referenced here rather than via tsconfig `types`, which resolves through
// `typeRoots` and so cannot see a package outside `node_modules/@types`.
/// <reference types="@webgpu/types" />
