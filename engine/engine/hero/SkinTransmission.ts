import { cameraViewMatrix, float, mix, normalViewGeometry, positionWorld, texture, uniform, vec2, vec3, vec4 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { SkinTransmissionPass } from 'engine/hero/SkinTransmissionPass.js';

/** d'Eon/Jimenez Gaussian transmission profile, evaluated in millimetres.
 * Entry distance is measured toward the light, unlike the old normal-ray proxy.
 */
export function skinTransmissionNode(pass: SkinTransmissionPass, light: Node<'vec3'>): Node<'vec3'> {
    const projected = uniform(pass.matrix).mul(vec4(positionWorld, 1));
    const at = vec2(projected.x, projected.y.oneMinus());
    // Bilinear reconstruction of depth avoids false thin regions on sloped faces.
    const grid = at.mul(pass.target.width).sub(.5), fraction = grid.fract();
    const base = grid.floor().add(.5).div(pass.target.width);
    const depth = texture(pass.target.depthTexture!);
    const entry = mix(mix(depth.sample(base).r, depth.sample(base.add(vec2(1 / pass.target.width, 0))).r, fraction.x),
        mix(depth.sample(base.add(vec2(0, 1 / pass.target.width))).r, depth.sample(base.add(vec2(1 / pass.target.width))).r, fraction.x), fraction.y);
    const range = uniform(1).onRenderUpdate(() => pass.camera.far - pass.camera.near);
    const enabled = uniform(1).onRenderUpdate(() => pass.enabled ? 1 : 0);
    const distance = projected.z.sub(entry).max(0).mul(range).mul(1000);
    const dd = distance.pow(2).negate();
    const profile = vec3(.233, .455, .649).mul(dd.div(.0064).exp())
        .add(vec3(.1, .336, .344).mul(dd.div(.0484).exp()))
        .add(vec3(.118, .198, 0).mul(dd.div(.187).exp()))
        .add(vec3(.113, .007, .007).mul(dd.div(.567).exp()))
        .add(vec3(.358, .004, 0).mul(dd.div(1.99).exp()))
        .add(vec3(.078, 0, 0).mul(dd.div(7.41).exp()));
    const key = uniform(pass.direction).transformDirection(cameraViewMatrix);
    const match = light.dot(key).greaterThan(.999);
    const valid = projected.x.greaterThan(0).and(projected.x.lessThan(1)).and(projected.y.greaterThan(0))
        .and(projected.y.lessThan(1)).and(projected.z.greaterThan(0)).and(projected.z.lessThan(1)).and(match);
    return profile.mul(normalViewGeometry.dot(light).negate().saturate()).mul(texture(pass.target.texture).sample(at).r)
        .mul(float(valid)).mul(distance.sub(.05).div(.1).saturate()).mul(enabled) as Node<'vec3'>;
}

export const SKIN_TRANSMISSION_GLSL = `
    uniform mat4 skinLightMatrix;
    uniform sampler2D skinEntryDepth, skinEntryMask;
    uniform vec3 skinKeyDirection;
    uniform float skinDepthRange, skinTransmissionEnabled;
    varying vec3 vSkinWorldPosition;
    vec3 skinTransmission(vec3 light,vec3 n){
        vec4 p=skinLightMatrix*vec4(vSkinWorldPosition,1.);
        if(any(lessThan(p.xyz,vec3(0.)))||any(greaterThan(p.xyz,vec3(1.))))return vec3(0.);
        vec3 key=normalize((viewMatrix*vec4(skinKeyDirection,0.)).xyz);
        if(dot(light,key)<.999)return vec3(0.);
        vec2 grid=p.xy*2048.-.5,f=fract(grid),b=(floor(grid)+.5)/2048.;
        float entry=mix(mix(texture2D(skinEntryDepth,b).r,texture2D(skinEntryDepth,b+vec2(1./2048.,0.)).r,f.x),
            mix(texture2D(skinEntryDepth,b+vec2(0.,1./2048.)).r,texture2D(skinEntryDepth,b+vec2(1./2048.)).r,f.x),f.y);
        float d=max(0.,p.z-entry)*skinDepthRange*1000.;
        float dd=-d*d;
        vec3 profile=vec3(.233,.455,.649)*exp(dd/.0064)+vec3(.1,.336,.344)*exp(dd/.0484)
            +vec3(.118,.198,0.)*exp(dd/.187)+vec3(.113,.007,.007)*exp(dd/.567)
            +vec3(.358,.004,0.)*exp(dd/1.99)+vec3(.078,0.,0.)*exp(dd/7.41);
        return profile*max(0.,-dot(n,light))*texture2D(skinEntryMask,p.xy).r*clamp((d-.05)/.1,0.,1.)*skinTransmissionEnabled;
    }
`;
