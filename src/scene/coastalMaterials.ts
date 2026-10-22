import { MeshStandardMaterial, ShaderChunk } from 'three'
import { waterCaustics } from './waterMaterials'
import { CONTAINER } from './containerConfig'

/** A subtle, metre-scaled dune texture without additional downloaded textures. */
export function sandSurface(material: MeshStandardMaterial, shoreline = false, time?: { value: number }) {
  material.onBeforeCompile = shader => {
    shader.uniforms.uSandTime = time ?? { value: 0 }
    shader.vertexShader = 'varying vec3 vCoastPosition; varying vec3 vCoastNormal;\n' + shader.vertexShader
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvCoastPosition=(modelMatrix*vec4(position,1.)).xyz; vCoastNormal=normalize(mat3(modelMatrix)*normal);')
    shader.fragmentShader = `varying vec3 vCoastPosition; varying vec3 vCoastNormal;
      uniform float uSandTime;
      ${shoreline ? waterCaustics : ''}
      float sandGrain(vec2 p){
        vec3 q=fract(vec3(p.xyx)*.1031);
        q+=dot(q,q.yzx+33.33);
        return fract((q.x+q.y)*q.z);
      }\n` + shader.fragmentShader
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
      vec2 p=vCoastPosition.xz;
      float resolution=max(fwidth(p.x),fwidth(p.y));
      float dune=sin(p.x*1.2+sin(p.y*.9))*sin(p.y*1.4-p.x*.3);
      float ripples=sin(p.x*22.+p.y*5.+sin(p.y*1.8)*1.4);
      float detail=1.-smoothstep(.012,.07,resolution);
      float grain=(sandGrain(floor(p*230.))-.5)*(1.-smoothstep(.002,.009,resolution));
      diffuseColor.rgb*=.99+dune*.025+ripples*.018*detail+grain*.11;
      ${shoreline ? `
      float wetSand=1.-smoothstep(-.02,.32,vCoastPosition.y+.012*dune);
      float coastFace=1.-smoothstep(.3,.8,abs(vCoastNormal.y));
      diffuseColor.rgb*=1.-wetSand*.13-coastFace*.045;
      float submerged=1.-smoothstep(-.10,${CONTAINER.waterY},vCoastPosition.y);
      float waterDepth=clamp((${CONTAINER.waterY}-vCoastPosition.y)/1.6,0.,1.);
      diffuseColor.rgb*=mix(vec3(1.),vec3(.38,.78,.75),waterDepth*.7);
      if(vCoastPosition.y<${CONTAINER.waterY}){
        diffuseColor.rgb+=vec3(.29,.34,.25)*waterCaustic(p,uSandTime)*detail*submerged;
      }
      ` : ''}
    `)
    if (shoreline) {
      // Scattered underwater light softens distant seabed shadows while dry
      // sand keeps its grounding contact shadows. No extra render pass.
      shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_begin>',
        ShaderChunk.lights_fragment_begin.replaceAll('directionalLightShadow.shadowIntensity',
          'directionalLightShadow.shadowIntensity * mix(.24,1.,smoothstep(-.8,.06,vCoastPosition.y))'))
    }
  }
  material.customProgramCacheKey = () => `coastal-white-sand-v5-${shoreline}`
  return material
}

/** Cool weathered shore rock, visually distinct from the warm movable money. */
function shoreRock(material: MeshStandardMaterial, time?: { value: number }) {
  material.onBeforeCompile = shader => {
    shader.uniforms.uRockTime = time ?? { value: 0 }
    shader.vertexShader = 'varying vec3 vShorePosition; varying vec3 vShoreNormal;\n' + shader.vertexShader
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      vShorePosition=(modelMatrix*vec4(position,1.)).xyz;
      vShoreNormal=normalize(mat3(modelMatrix)*normal);`)
    shader.fragmentShader = `varying vec3 vShorePosition; varying vec3 vShoreNormal;
      uniform float uRockTime;
      ${waterCaustics}\n` + shader.fragmentShader
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
      vec3 p=vShorePosition;
      float mineral=sin(p.x*5.+sin(p.z*6.))*sin(p.y*7.+p.z*3.);
      float fine=sin(p.x*47.+p.y*19.)*sin(p.z*39.-p.y*27.);
      float detail=1.-smoothstep(.018,.075,length(fwidth(p)));
      diffuseColor.rgb*=.96+mineral*.075+fine*.025*detail;
      float wet=1.-smoothstep(-.04,.24,p.y);
      diffuseColor.rgb*=1.-wet*.26;
      float moss=smoothstep(.42,.84,vShoreNormal.y)*smoothstep(.26,.8,p.y)
        *smoothstep(.12,.6,mineral)*.25;
      diffuseColor.rgb=mix(diffuseColor.rgb,vec3(.18,.24,.12),moss);
      if(p.y<${CONTAINER.waterY}){
        float depth=clamp((${CONTAINER.waterY}-p.y)/1.6,0.,1.);
        diffuseColor.rgb*=mix(vec3(1.),vec3(.42,.81,.79),depth*.65);
        diffuseColor.rgb+=vec3(.17,.23,.18)*waterCaustic(p.xz+p.y*.35,uRockTime)*detail;
      }
    `)
  }
  material.customProgramCacheKey = () => 'coastal-rock-v3'
}

export function environmentMaterial(source: MeshStandardMaterial, time?: { value: number }) {
  const material = source.clone()
  material.envMapIntensity = .08
  if (/sculpted coast/i.test(source.name)) {
    // Preserve the newly authored colours and mineral variations.
    if (/ivory/i.test(source.name)) sandSurface(material, true, time)
    else if (/limestone/i.test(source.name)) {
      shoreRock(material, time)
      if (/submerged/i.test(source.name)) {
        // Soft bounced light from the pale seabed keeps the downward-facing
        // island mass readable through water, instead of a near-black strip.
        material.emissive.set('#8da699')
        material.emissiveIntensity = .24
        material.emissiveMap = material.map
      }
    }
  } else if (/Wet shore sand/i.test(source.name)) {
    // The authored wet shoreline has no colour texture. Treating it like the
    // textured beach bleached its whole side into a pale, manufactured band.
    material.color.setRGB(.46, .35, .21)
    material.roughness = .82
    sandSurface(material, true, time)
  } else if (/ivory/i.test(source.name)) {
    material.color.setRGB(1.035, .99, .89)
    sandSurface(material, true, time)
  } else if (/Palm leaf/.test(source.name)) {
    material.color.multiplyScalar(.76)
    material.roughness = .82
  } else if (/limestone/.test(source.name)) {
    material.color.set('#b4b8b1')
    material.roughness = .94
    shoreRock(material)
  } else if (/sea green roof/.test(source.name)) {
    material.color.set('#315c59')
    material.roughness = .65
  }
  return material
}
