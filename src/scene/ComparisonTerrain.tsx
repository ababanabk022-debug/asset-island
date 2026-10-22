import { useEffect, useMemo } from 'react'
import { useLoader } from '@react-three/fiber'
import { BufferGeometry, Float32BufferAttribute, Mesh, MeshStandardMaterial, Raycaster, Vector3 } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { IslandContainer } from './IslandContainer'
import { IslandDetails, PalmCanopies } from './IslandDetails'
import { coastalShoreline } from './coastalShoreline'
import { environmentMaterial, sandSurface } from './coastalMaterials'

interface ComparisonTerrainProps {
  radiusX: number; radiusZ: number; visible: boolean; reduced?: boolean; far?: boolean
}
const SEGMENTS = 128
const shape = (angle: number) => 1 + .012 * Math.sin(angle * 3 + .7) + .007 * Math.cos(angle * 5 - .3)

/** Only carrying land expands for the very large estimate. */
function expandedIsland(radiusX: number, radiusZ: number) {
  const rings = [[.60, .555], [.86, .555], [.95, .28], [1, -.115],
    [.94, -.36], [.87, -.76], [.80, -1.14], [.74, -1.43]]
  const vertices = [0, .555, 0], indices: number[] = []
  for (const [radius, height] of rings) for (let i = 0; i < SEGMENTS; i++) {
    const angle = i / SEGMENTS * Math.PI * 2
    vertices.push(Math.cos(angle) * radiusX * radius * shape(angle), height, Math.sin(angle) * radiusZ * radius * shape(angle))
  }
  for (let i = 0; i < SEGMENTS; i++) indices.push(0, 1 + (i + 1) % SEGMENTS, 1 + i)
  const geometry = new BufferGeometry()
  geometry.addGroup(0, indices.length, 0)
  for (let ring = 0; ring < rings.length - 1; ring++) {
    const start = indices.length
    for (let i = 0; i < SEGMENTS; i++) {
      const a = 1 + ring * SEGMENTS + i, b = 1 + ring * SEGMENTS + (i + 1) % SEGMENTS
      const c = a + SEGMENTS, d = b + SEGMENTS
      indices.push(a, b, c, b, d, c)
    }
    geometry.addGroup(start, indices.length - start, ring < 3 ? 0 : 1)
  }
  const bottom = vertices.length / 3, start = indices.length
  vertices.push(0, -1.43, 0)
  for (let i = 0; i < SEGMENTS; i++) indices.push(bottom, 1 + 7 * SEGMENTS + i, 1 + 7 * SEGMENTS + (i + 1) % SEGMENTS)
  geometry.addGroup(start, indices.length - start, 1)
  geometry.setAttribute('position', new Float32BufferAttribute(vertices, 3))
  geometry.setIndex(indices); geometry.computeVertexNormals(); geometry.computeBoundingSphere()
  const shore = new Float32Array(128)
  const waterRatio = .95 + (.28 - .065) / (.28 + .115) * .05
  for (let i = 0; i < shore.length; i++) {
    const angle = i / shore.length * Math.PI * 2
    shore[i] = waterRatio * shape(angle) / Math.hypot(Math.cos(angle) / radiusX, Math.sin(angle) / radiusZ)
  }
  return { geometry, shore }
}

/** Exact home assets and dimensions, with no second running physics world. */
export function ComparisonTerrain({ radiusX, radiusZ, visible, reduced = false, far = false }: ComparisonTerrainProps) {
  const gltf = useLoader(GLTFLoader, '/generated/island-study.glb')
  const time = useMemo(() => ({ value: 0 }), [])
  const environment = useMemo(() => {
    const clone = gltf.scene.clone(true)
    clone.traverse(object => {
      if (!(object instanceof Mesh)) return
      if (/Palm.?leaf/.test(object.name + object.parent?.name)) { object.visible = false; return }
      object.castShadow = true; object.receiveShadow = true
      const materials = (Array.isArray(object.material) ? object.material : [object.material])
        .map(source => source instanceof MeshStandardMaterial ? environmentMaterial(source, time) : source.clone())
      object.material = Array.isArray(object.material) ? materials : materials[0]
    })
    return clone
  }, [gltf, time])
  const sourceShore = useMemo(() => coastalShoreline(gltf.scene), [gltf])
  const groundHeight = useMemo(() => {
    gltf.scene.updateMatrixWorld(true)
    const terrain: Mesh[] = []
    gltf.scene.traverse(object => {
      if (object instanceof Mesh && /Warm.?ivory.?sand/.test(object.name + object.parent?.name)) terrain.push(object)
    })
    const ray = new Raycaster(new Vector3(), new Vector3(0, -1, 0), 0, 20)
    return (x: number, z: number) => {
      ray.ray.origin.set(x, 10, z)
      return ray.intersectObjects(terrain, false)[0]?.point.y ?? .5
    }
  }, [gltf])
  const expanded = useMemo(() => {
    if (!far) return null
    const land = expandedIsland(radiusX * .80, radiusZ * .80)
    const sand = sandSurface(new MeshStandardMaterial({ color: '#eee5cf', roughness: .96 }), true, time)
    const sourceRock = new MeshStandardMaterial({ color: '#98a99c', roughness: .94 })
    sourceRock.name = 'Submerged limestone - sculpted coast'
    const rock = environmentMaterial(sourceRock, time)
    sourceRock.dispose()
    return { ...land, sand, rock }
  }, [far, radiusX, radiusZ, time])
  useEffect(() => () => {
    environment.traverse(object => {
      if (object instanceof Mesh && !/Palm.?leaf/.test(object.name + object.parent?.name))
        (Array.isArray(object.material) ? object.material : [object.material]).forEach(material => material.dispose())
    })
  }, [environment])
  useEffect(() => () => {
    expanded?.geometry.dispose(); expanded?.sand.dispose(); expanded?.rock.dispose()
  }, [expanded])
  // A full-size reference isle sits in the continental site's surrounding
  // water. Its house, boat, palms and rocks never scale with the asset mountain.
  const referenceX = far ? radiusX * .80 + 10 : 0
  return <group name="comparisonEnvironment" visible={visible}
    userData={{ kind: 'comparison-environment', source: '/generated/island-study.glb', sameAsPersonal: !far,
      environmentScale: 1, propScale: 1, waterRadiusX: radiusX, waterRadiusZ: radiusZ,
      staticPlacements: true, physicsRuntime: false, far }}>
    {expanded && <mesh name="Expanded white sand carrying island" geometry={expanded.geometry} material={[expanded.sand, expanded.rock]} receiveShadow dispose={null} />}
    <group name="Comparison full-size island reference" position={[referenceX, 0, 0]}>
      <primitive object={environment} dispose={null} />
      <IslandDetails reduced={reduced || !visible} groundHeight={groundHeight} />
      <PalmCanopies reduced={reduced || !visible} />
    </group>
    <IslandContainer reduced={reduced || !visible} shoreline={expanded?.shore ?? sourceShore}
      time={time} radiusX={radiusX} radiusZ={radiusZ} />
  </group>
}
