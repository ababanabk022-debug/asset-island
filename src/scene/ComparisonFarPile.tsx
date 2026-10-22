import { useEffect, useMemo } from 'react'
import { useThree } from '@react-three/fiber'
import { MeshStandardMaterial } from 'three'
import { useReserveEnvironment } from './reserveEnvironment'
import { buildComparisonEnvelope } from './comparisonEnvelope'
import { CELL } from '../domain/comparison'

interface ComparisonFarPileProps { amount: number; visible: boolean }

/** Far-view envelope of exact integer storage cells, including their air gaps.
 * This is NOT measured solid-metal volume. No individual nugget is enlarged:
 * the mesh exposes complete layers and the final row's exact remaining cells.
 * Its surface pattern has the original metre spacing and fades below a pixel. */
export function ComparisonFarPile({ amount, visible }: ComparisonFarPileProps) {
  const { gl } = useThree()
  const resources = useMemo(() => {
    const geometry = buildComparisonEnvelope(amount)

    const material = new MeshStandardMaterial({ color: '#c7a253', roughness: .58, metalness: .55, envMapIntensity: .42 })
    material.onBeforeCompile = shader => {
      shader.uniforms.uPileHeight = { value: geometry.boundingBox?.max.y ?? 0 }
      shader.uniforms.uPileCellSize = { value: CELL }
      const varyings = 'varying vec3 vPileCell; varying vec3 vPileNormal; varying vec3 vPileLocal; varying vec3 vPileBasisX; varying vec3 vPileBasisY; varying vec3 vPileBasisZ;\n'
      shader.vertexShader = 'attribute vec3 pileCell;\n' + varyings + shader.vertexShader
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        vPileCell=pileCell;vPileNormal=normal;vPileLocal=position;
        vPileBasisX=normalMatrix*vec3(1.,0.,0.);
        vPileBasisY=normalMatrix*vec3(0.,1.,0.);
        vPileBasisZ=normalMatrix*vec3(0.,0.,1.);
      `)
      shader.fragmentShader = 'uniform float uPileHeight; uniform vec3 uPileCellSize;\n' + varyings + shader.fragmentShader
      // At subpixel scales, lighting alternating horizontal and vertical steps
      // aliases even after texture filtering. Average the SHADING normal onto
      // the corresponding slope, leaving every counted layer/vertex unchanged.
      shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        vec3 cellFootprint=fwidth(vPileLocal/uPileCellSize);
        float averaged=smoothstep(.2,.85,max(cellFootprint.x,max(cellFootprint.y,cellFootprint.z)));
        vec3 slope;
        if(abs(vPileLocal.x/uPileCellSize.x)>abs(vPileLocal.z/uPileCellSize.z)) {
          slope=sign(vPileLocal.x)*vPileBasisX+(uPileCellSize.x/(2.*uPileCellSize.y))*vPileBasisY;
        } else {
          slope=sign(vPileLocal.z)*vPileBasisZ+(uPileCellSize.z/(2.*uPileCellSize.y))*vPileBasisY;
        }
        if(vPileLocal.y>=uPileHeight-.001 && vPileNormal.y>.5) averaged=0.;
        normal=normalize(mix(normal,normalize(slope),averaged));
        nonPerturbedNormal=normal;
      `)
      shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
        vec3 axis=abs(vPileNormal);
        vec2 tile=axis.y>.5?vPileCell.xz:(axis.x>.5?vPileCell.zy:vPileCell.xy);
        vec2 footprint=max(fwidth(tile),vec2(.0001));
        float detail=1.-smoothstep(.18,.8,max(footprint.x,footprint.y));
        vec2 within=fract(tile);
        vec2 edge=min(within,1.-within);
        vec2 filled=smoothstep(vec2(.023),vec2(.023)+footprint*.75,edge);
        float seam=1.-filled.x*filled.y;
        vec2 id=floor(tile);
        float grain=fract(sin(dot(id,vec2(127.1,311.7)))*43758.5453)-.5;
        float facet=step(within.x+within.y,1.)*.065+grain*.055;
        diffuseColor.rgb*=1.+detail*(facet-seam*.34);
      `)
    }
    material.customProgramCacheKey = () => 'comparison-far-cells-v2-filtered-lighting'
    return { geometry, material }
  }, [amount])
  const environmentMaterials = useMemo(() => [resources.material], [resources])
  useReserveEnvironment(gl, environmentMaterials)
  useEffect(() => () => { resources.geometry.dispose(); resources.material.dispose() }, [resources])
  return <mesh name="comparisonFarPile" userData={{ kind: 'comparison-envelope', representedGold: resources.geometry.userData.representedCount }}
    geometry={resources.geometry} material={resources.material} visible={visible && amount > 0} dispose={null} />
}
