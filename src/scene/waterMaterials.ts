import { BackSide, FrontSide, ShaderMaterial } from 'three'
import { CONTAINER } from './containerConfig'

type Time = { value: number }

const waves = `
  float waterHeight(vec2 p,float t){
    return .018*sin(dot(p,vec2(1.6,.72))+t*.75)
      +.011*sin(dot(p,vec2(-.9,2.1))-t*.6)
      +.006*sin(dot(p,vec2(5.8,4.1))+t*1.05);
  }
`
export const waterCaustics = `
  vec2 waterCell(vec2 p){
    vec3 h=fract(vec3(p.xyx)*vec3(.1031,.1030,.0973));
    h+=dot(h,h.yzx+33.33);
    return fract((h.xx+h.yz)*h.zy);
  }
  float waterCaustic(vec2 p,float t){
    vec2 q=p*2.8+.85*vec2(
      sin(p.y*1.7+sin(p.x*.83)+t*.13),
      sin(p.x*1.5+sin(p.y*.91)-t*.11));
    q+=.15*vec2(sin(p.y*5.+t*.09),cos(p.x*4.7-t*.12));
    vec2 cell=floor(q),local=fract(q);
    vec2 drift=vec2(sin(t*.23),cos(t*.19))*.17;
    float first=20.,second=20.;
    vec2 nearest=vec2(0.);
    // Irregular neighbouring lenses form connected bright edges without the
    // intersecting sine-grid pattern of the earlier water.
    for(int y=-1;y<=1;y++) for(int x=-1;x<=1;x++){
      vec2 offset=vec2(float(x),float(y));
      vec2 seed=waterCell(cell+offset);
      vec2 center=.12+.76*seed+drift*(seed.yx-.5);
      vec2 r=offset+center-local;
      float distance=dot(r,r);
      if(distance<first){second=first;first=distance;nearest=seed;}
      else second=min(second,distance);
    }
    float gap=sqrt(second)-sqrt(first);
    float line=1.-smoothstep(.018,.065+fwidth(gap)*.55,gap);
    float focus=.5+.5*sin(p.x*.83+p.y*.49+sin(p.y*1.17)+t*.17)
      *sin(p.y*.96-p.x*.37+sin(p.x*.7)-t*.12);
    focus=smoothstep(.36,.79,focus);
    float glimmer=.5+.5*sin(p.x*3.1+p.y*2.7+sin(p.y*2.3)+t*.25);
    float fragments=.25+.75*smoothstep(.15,.75,nearest.x+nearest.y*.25);
    return line*fragments*(.08+.92*focus)*(.25+.75*glimmer);
  }
`

/** Moving water normals and shore foam share a single inexpensive surface.
 * Underwater caustics are also drawn on the actual floor and rock materials. */
export function createWaterMaterial(time: Time, shoreline: Float32Array) {
  return new ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uTime: time, uShore: { value: shoreline } },
    vertexShader: `
      uniform float uTime;
      varying vec3 vWorld;
      varying vec2 vShoreLocal;
      ${waves}
      void main(){
        vec3 local=position;
        vShoreLocal=local.xz;
        vec3 worldBase=(modelMatrix*vec4(local,1.)).xyz;
        local.y+=waterHeight(worldBase.xz,uTime);
        vec4 p=modelMatrix*vec4(local,1.);
        vWorld=p.xyz;
        gl_Position=projectionMatrix*viewMatrix*p;
      }`,
    fragmentShader: `
      uniform float uTime;
      uniform float uShore[128];
      varying vec3 vWorld;
      varying vec2 vShoreLocal;
      ${waterCaustics}
      void main(){
        vec2 p=vWorld.xz;
        // Shore coordinates stay with their island; waves and caustics retain
        // metre-sized world detail when the comparison island is translated.
        float a=mod(atan(vShoreLocal.y,vShoreLocal.x)+6.28318530718,6.28318530718);
        float shoreIndex=a*(128./6.28318530718);
        int firstShore=int(floor(shoreIndex));
        int nextShore=firstShore==127?0:firstShore+1;
        float shoreRadius=mix(uShore[firstShore],uShore[nextShore],fract(shoreIndex));
        float shore=length(vShoreLocal)/max(.1,shoreRadius);
        float depth=smoothstep(1.,1.42,shore);
        float footprint=max(fwidth(p.x),fwidth(p.y));
        float detail=1.-smoothstep(.035,.16,footprint);
        float first=cos(dot(p,vec2(1.6,.72))+uTime*.75);
        float second=cos(dot(p,vec2(-.9,2.1))-uTime*.6);
        float third=cos(dot(p,vec2(5.8,4.1))+uTime*1.05)*detail;
        vec3 normal=normalize(vec3(-(.0288*first-.0099*second+.0348*third),
          1.,-(.01296*first+.0231*second+.0246*third)));
        vec3 eye=normalize(cameraPosition-vWorld);
        float fresnel=pow(1.-max(0.,dot(normal,eye)),3.);
        vec3 halfLight=normalize(eye+normalize(vec3(-.3,.9,.5)));
        float reflection=pow(max(0.,dot(normal,halfLight)),115.);
        float ripple=sin(p.x*13.+p.y*8.+sin(p.y*5.-uTime*.5)+uTime*.65);
        float glitter=pow(max(0.,ripple),18.)*reflection*detail;
        float skyGlint=pow(max(0.,ripple),22.)
          *pow(max(0.,sin(p.x*3.1-p.y*.7+sin(p.y*1.5)+uTime*.14)),10.)*detail;
        float patches=sin(p.x*.72+sin(p.y*.61))*sin(p.y*.64-p.x*.25);
        vec3 color=mix(vec3(.08,.56,.43),vec3(.012,.29,.35),depth);
        color*=1.+patches*.085;
        color=mix(color,vec3(.55,.76,.80),fresnel*.55);
        color+=reflection*vec3(.15,.19,.18)+glitter*vec3(.8,.87,.75);
        color+=skyGlint*vec3(.36,.46,.42)*(.6+fresnel);
        // Interrupted advancing foam follows the authored irregular shore.
        float tide=.011*sin(a*7.+uTime*.42)+.005*sin(a*23.-uTime*.3);
        float shoreLine=1.008+tide;
        float grit=.55+.45*sin(a*61.+sin(a*17.)*2.+uTime*.21);
        float foam=exp(-pow((shore-shoreLine)*92.,2.))*smoothstep(.18,.76,grit);
        float lace=exp(-pow((shore-shoreLine-.026)*115.,2.))
          *smoothstep(.64,.93,.5+.5*sin(a*83.+uTime*.26))*.32;
        float caustic=waterCaustic(p,uTime)*detail;
        color+=vec3(.065,.095,.075)*caustic*(1.-depth*.75);
        color=mix(color,vec3(.9,.97,.88),clamp((foam+lace)*detail*.7,0.,.76));
        // A matching submerged backdrop fills the far cutaway, so the surface
        // can transmit stones clearly without revealing the white page behind.
        float alpha=mix(.22,.40,depth)+fresnel*.05+reflection*.03+(foam+lace)*detail*.12;
        gl_FragColor=vec4(color,clamp(alpha,.22,.62));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  })
}

/** The top shares the surface wave, with no glass guard or manufactured rim. */
export function createWaterSideMaterial(time: Time, back: boolean) {
  if (back) return createSeabedMaterial(time, true)
  return new ShaderMaterial({
    transparent: true, depthWrite: false, side: FrontSide,
    uniforms: {
      uTime: time, uTop: { value: CONTAINER.waterY }, uBottom: { value: CONTAINER.floorY },
      uOpacity: { value: .32 },
    },
    vertexShader: `
      uniform float uTime; uniform float uTop; uniform float uBottom;
      varying vec3 vWorld; varying vec3 vNormal;
      ${waves}
      void main(){
        vec3 local=position;
        float height=clamp((local.y-uBottom)/(uTop-uBottom),0.,1.);
        vec3 worldBase=(modelMatrix*vec4(local,1.)).xyz;
        local.y+=waterHeight(worldBase.xz,uTime)*pow(height,4.);
        vec4 p=modelMatrix*vec4(local,1.);
        vWorld=p.xyz;vNormal=normalize(mat3(modelMatrix)*normal);
        gl_Position=projectionMatrix*viewMatrix*p;
      }`,
    fragmentShader: `
      varying vec3 vWorld; varying vec3 vNormal;
      uniform float uTime; uniform float uTop; uniform float uBottom; uniform float uOpacity;
      ${waves}
      ${waterCaustics}
      void main(){
        float height=clamp((vWorld.y-uBottom)/(uTop-uBottom),0.,1.);
        float facing=abs(dot(normalize(cameraPosition-vWorld),normalize(vNormal)));
        float edge=pow(1.-facing,2.);
        vec2 flow=vec2(vWorld.x+vWorld.z*.43,vWorld.y*1.6+vWorld.z*.58);
        float detail=1.-smoothstep(.04,.18,max(fwidth(flow.x),fwidth(flow.y)));
        float caustic=waterCaustic(flow,uTime*.8)*detail;
        float ripples=sin(vWorld.x*5.3+vWorld.z*4.1+sin(vWorld.y*7.)+uTime*.45);
        vec3 color=mix(vec3(.025,.20,.25),vec3(.055,.29,.32),height);
        color+=vec3(.055,.13,.11)*caustic*(.5+.5*height);
        color+=vec3(.018,.033,.029)*ripples*detail;
        color+=edge*vec3(.065,.10,.09);
        float surfaceY=uTop+waterHeight(vWorld.xz,uTime);
        float crest=exp(-pow((vWorld.y-surfaceY)*62.,2.));
        float sparkle=smoothstep(.55,.96,.5+.5*sin(vWorld.x*7.+vWorld.z*5.+uTime*.4));
        color+=crest*sparkle*vec3(.15,.22,.19)*detail;
        float alpha=uOpacity+(1.-height)*.12+edge*.13;
        alpha*=mix(.85,1.,smoothstep(0.,.13,height));
        gl_FragColor=vec4(color,clamp(alpha,.28,.62));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  })
}

/** Far-side optical absorption, entirely below the waterline. The actual white
 * seabed now belongs to the continuous exported island terrain. */
function createSeabedMaterial(time: Time, back: boolean) {
  return new ShaderMaterial({
    side: back ? BackSide : FrontSide,
    transparent: false, depthWrite: true,
    uniforms: {
      uTime: time, uTop: { value: CONTAINER.waterY }, uBottom: { value: CONTAINER.floorY },
      uBack: { value: back ? 1 : 0 },
    },
    vertexShader: `
      uniform float uTime;uniform float uTop;uniform float uBottom;uniform float uBack;
      varying vec3 vWorld;
      ${waves}
      void main(){
        vec3 local=position;
        float height=clamp((local.y-uBottom)/(uTop-uBottom),0.,1.);
        vec3 worldBase=(modelMatrix*vec4(local,1.)).xyz;
        local.y+=waterHeight(worldBase.xz,uTime)*pow(height,4.)*uBack;
        vec4 p=modelMatrix*vec4(local,1.);
        vWorld=p.xyz;
        gl_Position=projectionMatrix*viewMatrix*p;
      }`,
    fragmentShader: `
      uniform float uTime;uniform float uTop;uniform float uBottom;varying vec3 vWorld;
      void main(){
        vec2 p=vWorld.xz;
        float patches=sin(p.x*.8+sin(p.y*.9))*sin(p.y*.73);
        float height=clamp((vWorld.y-uBottom)/(uTop-uBottom),0.,1.);
        vec3 color=mix(vec3(.58,.66,.59),vec3(.12,.37,.39),height*.7);
        color*=1.+patches*.025;
        gl_FragColor=vec4(color,1.);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  })
}
