import { useEffect, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import { MeshStandardMaterial } from 'three'
import { CONTAINER } from './containerConfig'
import { createWaterCutaway, createWaterSurface } from './containerGeometry'
import { createWaterMaterial, createWaterSideMaterial } from './waterMaterials'
import { sandSurface } from './coastalMaterials'

/** A bounded piece of sea with a visible submerged island. Surface and cutaway
 * share their outline/waves; there is no glass vessel above the water. */
export function IslandContainer({ reduced = false, shoreline, time, radiusX = CONTAINER.waterRadius, radiusZ = radiusX }: {
  reduced?: boolean; shoreline: Float32Array; time: { value: number }; radiusX?: number; radiusZ?: number
}) {
  const resources = useMemo(() => {
    const surface = () => createWaterSurface(radiusX).scale(1, 1, radiusZ / radiusX)
    const seabed = surface()
    seabed.translate(0, CONTAINER.floorY, 0)
    return {
      time,
      seabed,
      sand: sandSurface(new MeshStandardMaterial({ color: '#eee5cf', roughness: .96 }), true, time),
      surface: surface(),
      side: createWaterCutaway(radiusX).scale(1, 1, radiusZ / radiusX),
      water: createWaterMaterial(time, shoreline),
      back: createWaterSideMaterial(time, true),
      front: createWaterSideMaterial(time, false),
    }
  }, [shoreline, time, radiusX, radiusZ])
  useEffect(() => () => {
    resources.surface.dispose()
    resources.seabed.dispose()
    resources.sand.dispose()
    resources.side.dispose()
    resources.water.dispose()
    resources.back.dispose()
    resources.front.dispose()
  }, [resources])
  useFrame((_, delta) => {
    if (!reduced) resources.time.value += Math.min(delta, .05)
  })
  return <group name="islandContainer" userData={{ kind: 'reserve-container', ...CONTAINER, waterRadiusX: radiusX, waterRadiusZ: radiusZ }} dispose={null}>
    <mesh name="White sand seabed" geometry={resources.seabed} material={resources.sand} receiveShadow />
    <mesh name="Submerged far water absorption" geometry={resources.side} material={resources.back} renderOrder={1} />
    <mesh name="Living coastal water surface" position={[0, CONTAINER.waterY, 0]} geometry={resources.surface} material={resources.water} renderOrder={2} />
    <mesh name="Water front cutaway" geometry={resources.side} material={resources.front} renderOrder={3} />
  </group>
}
