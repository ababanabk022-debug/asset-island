import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import {
  BufferGeometry, Color, Float32BufferAttribute, Group, MeshStandardMaterial,
} from 'three'
import { MarchingCubes } from 'three/addons/objects/MarchingCubes.js'
import { CONTAINER } from './containerConfig'

function sculptedCloud() {
  // Fuse shallow puffs once at load time. A continuous surface keeps rounded
  // cloud lobes without translucent sphere intersections or a flat disc.
  const material = new MeshStandardMaterial({
    vertexColors: true, roughness: 1, metalness: 0,
    emissive: '#edf4f2', emissiveIntensity: .5,
    transparent: true, opacity: .6, depthWrite: false,
  })
  const field = new MarchingCubes(40, material, false, false, 6000)
  const puffs = [
    [.29, .51, .50, .50], [.43, .60, .49, .70],
    [.59, .56, .51, .65], [.73, .50, .50, .40],
    [.48, .485, .54, .44], [.62, .48, .52, .30],
  ]
  puffs.forEach(([x, y, z, strength]) => field.addBall(x, y, z, strength, 12))
  field.update()
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(field.positionArray.slice(0, field.count * 3), 3))
  geometry.setAttribute('normal', new Float32BufferAttribute(field.normalArray.slice(0, field.count * 3), 3))
  field.geometry.dispose()
  geometry.scale(2.7, 1.65, 2.0)
  const positions = geometry.getAttribute('position')
  const colors = new Float32Array(positions.count * 3)
  const shade = new Color('#edf3f2'), light = new Color('#fffef7')
  for (let i = 0; i < positions.count; i++) {
    const y = positions.getY(i)
    const color = shade.clone().lerp(light, Math.min(1, Math.max(0, (y + .28) / .7)))
    colors[i * 3] = color.r; colors[i * 3 + 1] = color.g; colors[i * 3 + 2] = color.b
  }
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3))
  geometry.computeBoundingSphere()
  material.onBeforeCompile = shader => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
      float cloudFacing=abs(dot(normalize(vNormal),normalize(vViewPosition)));
      diffuseColor.a*=.36+.64*smoothstep(.02,.56,cloudFacing);
    `)
  }
  material.customProgramCacheKey = () => 'thin-translucent-cloud-v2'
  return {
    geometry, material,
  }
}

/** A real three-dimensional cloud, rendered in one draw. The bottom remains
 * fixed over CONTAINER.dropRadius; gentle motion never moves the drop origin. */
export function ReserveCloud({ reduced = false, activity = 0 }: { reduced?: boolean; activity?: number }) {
  const group = useRef<Group>(null)
  const cloud = useMemo(sculptedCloud, [])
  const current = useRef(0)
  useEffect(() => () => { cloud.geometry.dispose(); cloud.material.dispose() }, [cloud])
  useFrame(({ clock }, delta) => {
    if (!group.current) return
    current.current += (Math.max(0, Math.min(1, activity)) - current.current) * (1 - Math.exp(-Math.min(delta, .05) * 8))
    const t = clock.elapsedTime
    group.current.position.y = CONTAINER.cloud[1] + (reduced ? 0 : Math.sin(t * .7) * .035)
    const pulse = reduced ? 0 : current.current * .025
    group.current.scale.set(1 + pulse, 1 - pulse * .6, 1 + pulse)
    group.current.rotation.y = reduced ? 0 : Math.sin(t * .23) * .025
  })
  return <group ref={group} name="reserveCloud" position={CONTAINER.cloud} userData={{ kind: 'reserve-source', dropRadius: CONTAINER.dropRadius }}>
    <mesh geometry={cloud.geometry} material={cloud.material} dispose={null} />
  </group>
}
