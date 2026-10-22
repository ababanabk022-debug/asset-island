import { Box3, Color, InstancedBufferAttribute, InstancedMesh, Mesh, MeshStandardMaterial, type Group } from 'three'
import type { FreePhysicsAssets } from './FreeReservePhysics'
import type { Piece } from './reserveMotion'
import { sandstoneSurface } from './ReserveEffectsMaterials'
import { decodeCollisionProxy, type CollisionProxy } from './collisionMesh'

export const RESERVE_CAPACITY = 512
let collisionProxy: CollisionProxy | null = null
export const reserveAssetsReady = Promise.all([
  fetch('/generated/island-collision.bin', { cache: 'no-cache' }).then(response => {
    if (!response.ok) throw new Error('Island collision proxy could not be loaded')
    return response.arrayBuffer()
  }),
  fetch('/generated/manifest.json', { cache: 'no-cache' }).then(response => {
    if (!response.ok) throw new Error('Island asset manifest could not be loaded')
    return response.json() as Promise<{ assets: { file: string; sha256: string }[] }>
  }),
]).then(([bytes, manifest]) => {
  const proxy = decodeCollisionProxy(bytes)
  if (manifest.assets.find(asset => asset.file === 'island-study.glb')?.sha256 !== proxy.sourceSha256) throw new Error('Island collision proxy does not match the displayed asset')
  collisionProxy = proxy
})

/** Rendering keeps exported world-space geometry; contacts use its validated,
 * source-hash-bound proxy. Shore and ground queries keep the original terrain. */
export function prepareReserveAssets(models: Group[]) {
  if (!collisionProxy) throw new Error('Island collision proxy is not ready')
  const assets = { obstacles: [] } as unknown as FreePhysicsAssets
  assets.collisionProxy = collisionProxy
  const terrainVertices: number[] = [], terrainIndices: number[] = []
  const parts: { mesh: InstancedMesh; kind: Piece['kind'] }[] = []
  const occluders: Mesh[] = []
  models.forEach((scene, index) => {
    scene.updateMatrixWorld(true)
    const bounds = new Box3().setFromObject(scene)
    const centerY = (bounds.max.y + bounds.min.y) / 2
    scene.traverse(object => {
      if (!(object instanceof Mesh)) return
      const name = object.name + object.parent?.name
      if (index === 2 && /Palm.?leaf|Sandstone.?sample/.test(name)) return
      const geometry = object.geometry.clone().applyMatrix4(object.matrixWorld)
      if (index === 2) {
        occluders.push(object)
        if (/Island.?submerged.?body|Submerged.?island.?strata/.test(name)) { geometry.dispose(); return }
        const vertices = Float32Array.from(geometry.attributes.position.array)
        const indices = geometry.index ? Uint32Array.from(geometry.index.array) : Uint32Array.from({ length: vertices.length / 3 }, (_, i) => i)
        if (/Warm.?ivory.?sand/.test(name)) {
          const offset = terrainVertices.length / 3
          for (const vertex of vertices) terrainVertices.push(vertex)
          for (const value of indices) terrainIndices.push(value + offset)
        } else assets.obstacles!.push({ vertices, indices })
        geometry.dispose()
        return
      }
      geometry.translate(0, -centerY, 0)
      geometry.setAttribute('fracture', new InstancedBufferAttribute(new Float32Array(RESERVE_CAPACITY), 1))
      const kind = index === 0 ? 'sand' : 'gold'
      assets[kind] = { vertices: new Float32Array([...(assets[kind]?.vertices ?? []), ...geometry.attributes.position.array]), centerY }
      const materials = (Array.isArray(object.material) ? object.material : [object.material]).map(source => {
        const material = source.clone() as MeshStandardMaterial
        material.envMapIntensity = kind === 'gold' ? .55 : .07
        if (kind === 'sand') sandstoneSurface(material)
        else { material.roughness = Math.max(.34, material.roughness); material.metalness = .78 }
        const surface = material.onBeforeCompile
        material.onBeforeCompile = (shader, renderer) => {
          surface.call(material, shader, renderer)
          shader.vertexShader = 'attribute float fracture; varying float vFracture; varying vec3 vRock;\n' + shader.vertexShader
          shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvFracture=fracture; vRock=position;')
          shader.fragmentShader = 'varying float vFracture; varying vec3 vRock;\n' + shader.fragmentShader
          shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\nfloat seam=min(abs(vRock.x+.13*sin(vRock.y*9.)+.07*sin(vRock.z*15.)),abs(vRock.z-.12*sin(vRock.x*10.)+.3*vRock.y)); float fissure=(1.-smoothstep(.006,.012+.025*vFracture,seam))*vFracture; diffuseColor.rgb=mix(diffuseColor.rgb,vec3(.055,.025,.009),fissure);')
        }
        material.customProgramCacheKey = () => `playable-reserve-v1-${kind}`
        return material
      })
      const mesh = new InstancedMesh(geometry, Array.isArray(object.material) ? materials : materials[0], RESERVE_CAPACITY)
      mesh.setColorAt(0, new Color(1, 1, 1))
      mesh.count = 0
      mesh.castShadow = true; mesh.receiveShadow = true; mesh.frustumCulled = false
      mesh.userData.personalReserve = true; mesh.userData.personalReserveKind = kind
      parts.push({ mesh, kind })
    })
  })
  if (!terrainIndices.length) throw new Error('Island collision surface missing')
  assets.terrain = { vertices: new Float32Array(terrainVertices), indices: new Uint32Array(terrainIndices) }
  return { assets, parts, occluders }
}
