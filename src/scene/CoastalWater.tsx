import { useEffect, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import { Color, ShaderMaterial } from 'three'

/** Bounded water, shared by all island sizes. Frequencies are in world metres;
 * derivatives remove subpixel details when the camera travels to a huge island. */
export function CoastalWater({ radiusX = 8.28, radiusZ = 8.28, original = false, reduced = false }: {
  radiusX?: number; radiusZ?: number; original?: boolean; reduced?: boolean
}) {
  const material = useMemo(() => new ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: {
      uTime: { value: 0 }, uOriginal: { value: original ? 1 : 0 },
      uShallow: { value: new Color('#a4d9cc') }, uDeep: { value: new Color('#65b3b8') },
    },
    vertexShader: `
      varying vec2 vLocal; varying vec2 vWorld;
      void main(){
        vLocal=position.xy; vec4 p=modelMatrix*vec4(position,1.);
        vWorld=p.xz; gl_Position=projectionMatrix*viewMatrix*p;
      }`,
    fragmentShader: `
      varying vec2 vLocal; varying vec2 vWorld;
      uniform float uTime; uniform float uOriginal;
      uniform vec3 uShallow; uniform vec3 uDeep;
      float waves(vec2 p){
        return sin(p.x+sin(p.y*.87))*.5+sin(p.y*1.17+sin(p.x*.63))*.5;
      }
      void main(){
        vec2 shoreP=mix(vec2(vLocal.x,-vLocal.y)*1.2,vLocal*vec2(8.28/5.4,8.28/4.45),uOriginal);
        float a=atan(shoreP.y,shoreP.x);
        float shape=mix(1.+.014*sin(a*3.+.7)+.009*cos(a*5.-.3),
          1.+.045*sin(3.*a+.4)+.027*cos(5.*a),uOriginal);
        float shore=length(shoreP)/shape;
        float depth=smoothstep(.99,1.62,shore);
        vec3 color=mix(uShallow,uDeep,depth);
        float footprint=max(fwidth(vWorld.x),fwidth(vWorld.y));
        float detail=1.-smoothstep(.03,.18,footprint);
        vec2 p=vWorld;
        // Broad sand bars under the shallows, fine interference on top.
        float bar=waves(p*.85+vec2(.6,-.2));
        color=mix(color,vec3(.47,.72,.63),(.06+.05*bar)*(1.-depth)*detail);
        vec2 q=p*3.+vec2(uTime*.13,-uTime*.09);
        float c1=waves(q+waves(q*.61+uTime*.12));
        float c2=waves(q*1.37-vec2(uTime*.08));
        float caustic=pow(clamp(1.-abs(c1+c2*.48),0.,1.),18.);
        color+=caustic*.095*(1.-depth)*detail;
        float swell=waves(p*1.9+vec2(uTime*.17,uTime*.09));
        color+=swell*.014*detail;
        float highlight=pow(max(0.,waves(p*3.7+uTime*.19)),22.)*.075;
        color+=vec3(.92,.98,.91)*highlight*detail;
        // Soft sets of waves arrive at the actual shoreline, not a circle.
        float wave=fract((shore-1.)*7.-uTime*.075);
        float crest=smoothstep(.82,.94,wave)*(1.-smoothstep(.94,1.,wave));
        float surf=crest*(1.-smoothstep(1.,1.21,shore))*smoothstep(.97,1.,shore);
        float beach=exp(-pow((shore-1.008)*55.,2.))*(.22+.08*sin(a*38.));
        color=mix(color,vec3(.82,.95,.88),clamp((surf*.26+beach)*detail,0.,.45));
        // Dissolve into the page's atmosphere; no vertical aquarium wall.
        float edge=length(vLocal);
        float alpha=1.-smoothstep(.67,1.,edge);
        gl_FragColor=vec4(color,alpha*.97);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  }), [original])
  useEffect(() => () => material.dispose(), [material])
  useFrame((_, delta) => { if (!reduced) material.uniforms.uTime.value += Math.min(delta, .05) })
  return <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, .065, 0]} scale={[radiusX, radiusZ, 1]} material={material}>
    <circleGeometry args={[1, 128]} />
  </mesh>
}
