import type { MeshStandardMaterial } from 'three'

/** Warm sandstone remains readable against cool shore rocks and wet sand.
 * Authored strata stay intact; fine detail fades below one pixel. */
export function sandstoneSurface(material: MeshStandardMaterial) {
  material.roughness = .9
  material.bumpMap = material.map
  material.bumpScale = .008
  material.onBeforeCompile = shader => {
    shader.vertexShader = 'varying vec3 vStonePosition;\n' + shader.vertexShader
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvStonePosition=position;')
    shader.fragmentShader = 'varying vec3 vStonePosition;\n' + shader.fragmentShader
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
      float mineralLuma=dot(diffuseColor.rgb,vec3(.2126,.7152,.0722));
      vec3 paleMineral=vec3(.64,.49,.31)*(.72+mineralLuma*.72);
      float stoneDetail=1.-smoothstep(.015,.065,length(fwidth(vStonePosition)));
      float stratum=sin(vStonePosition.y*62.+sin(vStonePosition.x*8.)*.7+vStonePosition.z*4.);
      diffuseColor.rgb=mix(diffuseColor.rgb,paleMineral,.87)*(1.+stratum*.025*stoneDetail);
    `)
  }
  material.customProgramCacheKey = () => 'warm-sandstone-v2'
}
