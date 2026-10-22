import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useLoader, useThree } from '@react-three/fiber'
import { Box3, Color, InstancedMesh, Matrix4, Mesh, MeshStandardMaterial, Quaternion, Vector3 } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { largeReserveCells } from './largeReserveLayout'
import type { ReserveProps } from './Reserve'
import { ComparisonTerrain } from './ComparisonTerrain'
import { useReserveEnvironment } from './reserveEnvironment'
import { ReserveEffects } from './ReserveEffects'
import { soundEngine } from '../audio/soundEngine'
import type { Impact } from './reservePhysics'
import { DetailGarden, PalmCanopies } from './IslandDetails'
import { environmentMaterial } from './coastalMaterials'
import { sandstoneSurface } from './ReserveEffectsMaterials'

const DURATION = 1.35
const smooth = (t: number) => { const x = Math.max(0, Math.min(1, t)); return x * x * (3 - 2 * x) }
/** Larger personal balances keep every gold unit at its original .45 scale.
 * The final stack is exact; only the last twenty changing units take a visible
 * flight so a large transfer never creates hundreds of physical bodies. */
export function LargeReserve({ amount, transaction, onComplete, onPhase, reduced = false }: ReserveProps) {
  const models = useLoader(GLTFLoader, ['/generated/sandstone.glb', '/generated/gold.glb', '/generated/island-study.glb'])
  const { gl, camera } = useThree()
  const effects = useMemo(() => new ReserveEffects(), [])
  const impacts = useRef<Impact[]>([])
  const emitted = useRef(new Set<string>())
  const decoration = useMemo(() => {
    const group = models[2].scene.clone(true)
    const removed: Mesh[] = [], materials: MeshStandardMaterial[] = []
    group.traverse(object => {
      if (!(object instanceof Mesh)) return
      if (/Sandstone.?sample|Warm.?ivory|Warm.?weathered.?limestone|Palm.?leaf/.test(object.name + object.parent?.name)) { removed.push(object); return }
      const copies = (Array.isArray(object.material) ? object.material : [object.material]).map(source => {
        const material = environmentMaterial(source as MeshStandardMaterial)
        materials.push(material)
        return material
      })
      object.material = Array.isArray(object.material) ? copies : copies[0]
      object.castShadow = true; object.receiveShadow = true
    })
    removed.forEach(object => object.removeFromParent())
    // The GLB merges cottage, pier and palm trunks by material. Preserve all
    // wood, fittings, canopy, roof and foliage meshes at their original scale.
    // This offset keeps even the widest palm clear of the 1,000-unit stack.
    group.position.set(-9.4, 0, 1)
    return { group, materials }
  }, [models])
  useEffect(() => () => decoration.materials.forEach(material => material.dispose()), [decoration])
  const parts = useMemo(() => models.slice(0, 2).flatMap((gltf, modelIndex) => {
    gltf.scene.updateMatrixWorld(true)
    const bounds = new Box3().setFromObject(gltf.scene), result: { mesh: InstancedMesh; kind: 'gold' | 'sand' }[] = []
    gltf.scene.traverse(object => {
      if (!(object instanceof Mesh)) return
      const geometry = object.geometry.clone().applyMatrix4(object.matrixWorld)
      geometry.translate(-(bounds.min.x + bounds.max.x) / 2, -bounds.min.y, -(bounds.min.z + bounds.max.z) / 2)
      const kind = modelIndex === 1 ? 'gold' : 'sand'
      const materials = (Array.isArray(object.material) ? object.material : [object.material]).map(source => {
        const material = source.clone() as MeshStandardMaterial
        material.envMapIntensity = kind === 'gold' ? .55 : .07
        material.roughness = kind === 'gold' ? Math.max(.34, material.roughness) : .93
        if (kind === 'gold') material.metalness = .78
        else sandstoneSurface(material)
        return material
      })
      const mesh = new InstancedMesh(geometry, Array.isArray(object.material) ? materials : materials[0], kind === 'gold' ? 1000 : 10)
      mesh.setColorAt(0, new Color(1, 1, 1))
      mesh.count = 0; mesh.frustumCulled = false
      mesh.userData.personalReserve = true; mesh.userData.personalReserveKind = kind
      result.push({ mesh, kind })
    })
    return result
  }), [models])
  const materials = useMemo(() => parts.flatMap(({ mesh }) => Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as MeshStandardMaterial[], [parts])
  useReserveEnvironment(gl, materials)
  const layout = useMemo(() => ({ before: largeReserveCells(transaction?.before ?? amount), after: largeReserveCells(amount) }), [amount, transaction])
  const state = useRef({ key: '', elapsed: 0, finished: false })
  const scratch = useMemo(() => ({ matrix: new Matrix4(), position: new Vector3(), target: new Vector3(), scale: new Vector3(), rotation: new Quaternion(), axis: new Vector3(0, 1, 0), color: new Color() }), [])
  useEffect(() => () => parts.forEach(({ mesh }) => {
    mesh.geometry.dispose(); (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach(material => material.dispose()); mesh.dispose()
  }), [parts])
  useEffect(() => () => { effects.dispose(); soundEngine.stop() }, [effects])
  useFrame((_, delta) => {
    const key = `${amount}:${transaction?.id ?? 'rest'}`
    if (state.current.key !== key) {
      soundEngine.stop(); impacts.current = []; emitted.current.clear()
      state.current = { key, elapsed: transaction ? 0 : DURATION, finished: false }
      onPhase(transaction ? (transaction.type === 'income' ? '金矿陆续到岸 · 储备增长' : '金矿离岛 · 储备重新归位') : '储备已归位')
    }
    if (state.current.finished) return
    // A save can resolve after the preference changes while waiting for the
    // ledger lock. Enforce current reduced motion at the renderer boundary.
    state.current.elapsed = reduced ? DURATION : Math.min(DURATION, state.current.elapsed + delta)
    const t = state.current.elapsed, progress = smooth(t / DURATION), done = t >= DURATION
    for (const { mesh, kind } of parts) {
      const before = layout.before[kind], after = layout.after[kind], shared = Math.min(before.length, after.length)
      const count = done ? after.length : Math.max(before.length, after.length)
      mesh.count = count
      for (let i = 0; i < count; i++) {
        const from = before[i], to = after[i], cell = to ?? from
        let scale = cell.scale, rotation = kind === 'gold' && i % 3 === 0 ? Math.PI : 0
        scratch.position.set(...cell.position)
        if (!done) {
          if (from && to) {
            scratch.position.set(...from.position).lerp(scratch.target.set(...to.position), progress)
            scale = from.scale + (to.scale - from.scale) * progress
          } else {
            const representative = i >= Math.max(shared, count - 20)
            const stagger = (i % 20) * .012
            const p = smooth((t - stagger) / .78)
            if (to) {
              scale *= smooth((t - stagger) / .12)
              if (representative) {
                const flight = Math.max(0, Math.min(1, (t - stagger) / .65))
                const landed = Math.max(0, t - stagger - .65)
                // Acceleration into the landing, followed by a small damped
                // rebound. The denomination itself never squashes or grows.
                scratch.position.y += (1 - flight * flight) * 2.4 + Math.abs(Math.sin(landed * 20)) * Math.exp(-landed * 14) * .09
                scratch.position.x += (1 - flight) * .65
                rotation += (1 - flight) * .9
                const eventKey = `${kind}:${i}`
                if (flight === 1 && !emitted.current.has(eventKey)) {
                  emitted.current.add(eventKey)
                  impacts.current.push({ position: [...cell.position], time: t, strength: .65, gold: kind === 'gold', effect: kind === 'gold' && i === count - 1 ? 'merge' : undefined })
                  soundEngine.play(kind === 'gold' ? 'gold' : 'stone', .55)
                }
              }
            } else {
              scale *= 1 - smooth((t - stagger - .42) / .36)
              if (representative) {
                scratch.position.x += p * 4.5; scratch.position.y += Math.sin(p * Math.PI) * 1.8; rotation += p * 2.5
                const eventKey = `${kind}:${i}`
                if (t > stagger + .04 && !emitted.current.has(eventKey)) {
                  emitted.current.add(eventKey)
                  impacts.current.push({ position: [...cell.position], time: t, strength: .5, gold: kind === 'gold' })
                  soundEngine.play('stone', .35)
                }
              }
            }
          }
        }
        scratch.rotation.setFromAxisAngle(scratch.axis, rotation); scratch.scale.setScalar(Math.max(.000001, scale))
        mesh.setMatrixAt(i, scratch.matrix.compose(scratch.position, scratch.rotation, scratch.scale))
        scratch.color.setScalar(kind === 'gold' ? .89 + (i % 7) * .017 : .9 + i % 3 * .04)
        mesh.setColorAt(i, scratch.color)
      }
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    }
    impacts.current = impacts.current.filter(impact => t - impact.time < .5)
    effects.update(impacts.current, t, camera.quaternion)
    if (done) {
      effects.clear()
      state.current.finished = true
      onPhase('储备已归位')
      if (transaction) onComplete(transaction.id)
    }
  })
  return <group>
    <ComparisonTerrain radiusX={15} radiusZ={13} visible reduced={reduced} />
    <primitive object={decoration.group} dispose={null} /><group position={[-9.4, 0, 1]}><DetailGarden /><PalmCanopies reduced={reduced} /></group>
    <group position={[2, 0, 0]}>{parts.map(({ mesh }, i) => <primitive key={i} object={mesh} dispose={null} />)}<primitive object={effects.group} dispose={null} /></group>
  </group>
}

