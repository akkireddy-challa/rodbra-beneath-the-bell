export const SkyboxFragmentShader = `
precision mediump float;

#define PI 3.1415926

uniform sampler2D skyboxTexture;
uniform vec2  texelSize;

uniform float mainRotation;
uniform float seamFeather;
uniform float seamWidthMin;
uniform float seamWidthMax;
uniform float contrastLow;
uniform float contrastHigh;

uniform vec2 screenSize;
uniform float brightness;

varying vec3 vWorldPos;

vec3 rotateY(vec3 v, float rad) {
    float s = sin(rad), c = cos(rad);
    return vec3(c * v.x - s * v.z, v.y, s * v.x + c * v.z);
}

vec2 dirToEquirectUV(vec3 d) {
    float phi = atan(d.z, d.x);
    float u = 0.5 - phi / (2.0 * PI);
    float v = acos(clamp(d.y, -1.0, 1.0)) / PI;
    return vec2(u, v);
}

void main() {
    vec3 dir;
    dir = normalize(cameraPosition - vWorldPos);

    // flip to look outward
    dir = -dir;

    float yaw = radians(mainRotation);
    vec3 rdir = rotateY(dir, yaw);

    vec2 uv = dirToEquirectUV(rdir);

    // fractional U for seam logic
    float uFrac = fract(uv.x);
    float v     = -uv.y;

    // keep samples away from exact wrap edges to avoid the seam
    float halfTexel = max(0.5 * texelSize.x, 1e-6);
    float uSample    = clamp(uFrac, halfTexel, 1.0 - halfTexel);
    float uOppSample = clamp(1.0 - uFrac, halfTexel, 1.0 - halfTexel);

    vec3 c0 = texture2D(skyboxTexture, vec2(uSample, v)).rgb;
    vec3 c1 = texture2D(skyboxTexture, vec2(uOppSample, v)).rgb;

    float l0 = dot(c0, vec3(0.2126, 0.7152, 0.0722)); // luminance
    float l1 = dot(c1, vec3(0.2126, 0.7152, 0.0722));
    float lumDiff = abs(l1 - l0);
    float denom = max(contrastHigh - contrastLow, 1e-6);
    float t01 = clamp((lumDiff - contrastLow) / denom, 0.0, 1.0);
    float seamWidth = max(mix(seamWidthMin, seamWidthMax, t01), 1e-4);

    // blend only near LEFT edge
    float w = smoothstep(seamWidth, 0.0, uFrac); //

    w = clamp(w + seamFeather * (w*w - w), 0.0, 1.0);
    w = w * w * (3.0 - 2.0 * w);

    vec3 col = mix(c0, c1, w);

    gl_FragColor = vec4(col * brightness, 1.0);
    // Same output transform every other path applies to the sky (the WebGPU
    // renderer's output pass, the WebGL composer's OutputPass). Both includes
    // are no-ops while rendering into a composer target.
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
`;