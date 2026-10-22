import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useLoader, useThree } from '@react-three/fiber'
import { Box3, Group, InstancedMesh, Matrix4, Mesh, MeshStandardMaterial, Quaternion, Vector3 } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { useReserveEnvironment } from './reserveEnvironment'
import { comparisonLayout, COMPARISON_EXAMPLES, COMPARISON_GROUND, COMPARISON_RUNTIME_SCALE, COMPARISON_WATER_RADIUS, MUSK_SNAPSHOT } from '../domain/comparison'
import { ComparisonTerrain } from './ComparisonTerrain'
import { ComparisonFarPile } from './ComparisonFarPile'
import { COMPARISON_PLACEMENTS } from './comparisonPlacements'
import { sandstoneSurface } from './ReserveEffectsMaterials'

const DROP_DURATION = .70
interface ComparisonReserveProps {
  amount: number; visible: boolean; reduced?: boolean; arrivalReady?: boolean
}

/** Static, source-bound poses are baked offline against the real island.
 * Entry is a short presentation motion, with no second physics world. */
export function ComparisonReserve({ amount, visible, reduced = false, arrivalReady = true }: ComparisonReserveProps) {
  const models = useLoader(GLTFLoader, ['/generated/sandstone.glb', '/generated/gold.glb'])
  const { gl } = useThree()
  const root = useRef<Group>(null)
  const ordinary = useRef<Group>(null)
  const animation = useRef({ elapsed: DROP_DURATION, running: false })
  const entry = useRef({ amount: -1, played: false, replay: 0 })
  const farLayout = useMemo(() => comparisonLayout(MUSK_SNAPSHOT.amount), [])
  const layout = useMemo(() => comparisonLayout(amount), [amount])
  const metadata = useMemo(() => ({ kind: 'comparison-reserve', amount, far: layout.far, goldCount: layout.goldCount,
    sandCount: layout.sandCount, unitScale: COMPARISON_RUNTIME_SCALE, dropRunning: false, dropProgress: 1,
    dropSkipped: '', arrivalReady: false, animationState: 'settled', replay: 0 }), [amount, layout])
  const poses = useMemo(() => {
    const example = COMPARISON_EXAMPLES.find(item => item.amount === amount)
    return example && !layout.far ? COMPARISON_PLACEMENTS[example.id] ?? [] : []
  }, [amount, layout.far])
  const parts = useMemo(() => models.flatMap((gltf, modelIndex) => {
    gltf.scene.updateMatrixWorld(true)
    const bounds = new Box3().setFromObject(gltf.scene)
    const centerY = (bounds.min.y + bounds.max.y) / 2
    const kind = modelIndex === 0 ? 'sand' : 'gold'
    const meshes: { mesh: InstancedMesh; kind: 'sand' | 'gold' }[] = []
    gltf.scene.traverse(object => {
      if (!(object instanceof Mesh)) return
      // Keep the same model origin and dimensions as personal reserve physics.
      const geometry = object.geometry.clone().applyMatrix4(object.matrixWorld)
      geometry.translate(0, -centerY, 0)
      const materials = (Array.isArray(object.material) ? object.material : [object.material]).map(source => {
        const material = source.clone() as MeshStandardMaterial
        material.envMapIntensity = kind === 'gold' ? .55 : .07
        if (kind === 'sand') sandstoneSurface(material)
        else { material.roughness = Math.max(.34, material.roughness); material.metalness = .78 }
        return material
      })
      const mesh = new InstancedMesh(geometry, Array.isArray(object.material) ? materials : materials[0], 100)
      mesh.count = 0
      mesh.name = `Comparison ${kind} instances`
      mesh.userData = { comparisonGold: kind === 'gold', comparisonSand: kind === 'sand', comparisonKind: kind }
      mesh.frustumCulled = false
      mesh.castShadow = true; mesh.receiveShadow = true
      meshes.push({ mesh, kind })
    })
    return meshes
  }), [models])
  const draw = useMemo(() => {
    const matrix = new Matrix4(), rotation = new Quaternion(), position = new Vector3()
    const scale = new Vector3().setScalar(COMPARISON_RUNTIME_SCALE)
    const byKind = { sand: poses.filter(pose => pose.kind === 'sand'), gold: poses.filter(pose => pose.kind === 'gold') }
    return (elapsed: number) => {
      for (const { mesh, kind } of parts) {
        const placements = byKind[kind]
        mesh.count = placements.length
        placements.forEach((pose, i) => {
          const delay = (i * 17 % 11) / 10 * .045
          const t = Math.max(0, Math.min(1, (elapsed - delay) / (DROP_DURATION - .045)))
          const fall = Math.min(1, t / .76)
          const bounce = t <= .76 ? 0 : Math.sin((t - .76) / .24 * Math.PI) * .065 * (1 - (t - .76) / .24)
          const height = elapsed >= DROP_DURATION ? 0 : (1 - fall * fall) * (2.1 + (i * 7 % 9) * .035) + bounce
          position.set(pose.position[0], pose.position[1] + height, pose.position[2])
          rotation.fromArray(pose.orientation)
          mesh.setMatrixAt(i, matrix.compose(position, rotation, scale))
        })
        mesh.instanceMatrix.needsUpdate = true
      }
      gl.shadowMap.needsUpdate = true
    }
  }, [gl, parts, poses])
  useEffect(() => {
    if (entry.current.amount !== amount || !visible) {
      entry.current.amount = amount; entry.current.played = false
    }
    const play = visible && arrivalReady && !entry.current.played && !layout.far && !reduced && !document.hidden
    if (visible && (arrivalReady || reduced)) entry.current.played = true
    if (play) entry.current.replay++
    animation.current = { elapsed: play ? 0 : DROP_DURATION, running: play }
    draw(play ? 0 : DROP_DURATION)
    if (ordinary.current) ordinary.current.visible = !layout.far && (arrivalReady || reduced || entry.current.played)
    if (root.current) Object.assign(root.current.userData, {
      arrivalReady, replay: entry.current.replay, dropRunning: play, dropProgress: play ? 0 : 1,
      animationState: play ? 'dropping' : visible && !arrivalReady && !entry.current.played ? 'waiting' : 'settled',
      dropSkipped: layout.far ? 'large-estimate' : document.hidden ? 'background' : reduced ? 'reduced-motion' : !arrivalReady ? 'camera-travel' : !visible ? 'hidden' : '',
    })
  }, [amount, arrivalReady, draw, layout.far, reduced, visible])
  useEffect(() => {
    const finishHidden = () => {
      if (!document.hidden) return
      animation.current.running = false; animation.current.elapsed = DROP_DURATION
      draw(DROP_DURATION)
      entry.current.played = true
      if (root.current) Object.assign(root.current.userData, { dropRunning: false, dropProgress: 1, dropSkipped: 'background', animationState: 'settled' })
    }
    document.addEventListener('visibilitychange', finishHidden)
    return () => document.removeEventListener('visibilitychange', finishHidden)
  }, [draw])
  useFrame((_, delta) => {
    if (!animation.current.running) return
    animation.current.elapsed = Math.min(DROP_DURATION, animation.current.elapsed + Math.min(delta, .05))
    draw(animation.current.elapsed)
    animation.current.running = animation.current.elapsed < DROP_DURATION
    if (root.current) Object.assign(root.current.userData, {
      dropRunning: animation.current.running, dropProgress: animation.current.elapsed / DROP_DURATION,
      animationState: animation.current.running ? 'dropping' : 'settled',
    })
  })
  const environmentMaterials = useMemo(() => parts.flatMap(({ mesh }) => Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as MeshStandardMaterial[], [parts])
  useReserveEnvironment(gl, environmentMaterials)
  useEffect(() => () => parts.forEach(({ mesh }) => {
    mesh.geometry.dispose()
    ;(Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach(material => material.dispose())
    mesh.dispose()
  }), [parts])
  return <group ref={root} name="comparisonReserve" position={[layout.position[0], 0, 0]} visible={visible}
    userData={metadata}>
    <ComparisonTerrain reduced={reduced} radiusX={COMPARISON_WATER_RADIUS} radiusZ={COMPARISON_WATER_RADIUS} visible={visible && !layout.far} />
    <ComparisonTerrain reduced={reduced} radiusX={farLayout.radiusX} radiusZ={farLayout.radiusZ} visible={visible && layout.far} far />
    <group ref={ordinary} visible={!layout.far}>
      {parts.map(({ mesh }, index) => <primitive key={index} object={mesh} dispose={null} />)}
    </group>
    <group position={[0, COMPARISON_GROUND, 0]}>
      <ComparisonFarPile amount={layout.far ? amount : MUSK_SNAPSHOT.amount} visible={visible && layout.far} />
    </group>
  </group>
}
