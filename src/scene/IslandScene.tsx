import { Suspense, useEffect, useMemo, useRef, type RefObject } from 'react'
import { Canvas, useFrame, useLoader, useThree } from '@react-three/fiber'
import { ACESFilmicToneMapping, Group, Mesh, MeshStandardMaterial, PCFSoftShadowMap, Raycaster, SRGBColorSpace, Vector3 } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { CameraRig, type CameraStatus } from './CameraRig'
import { ComparisonReserve } from './ComparisonReserve'
import { TransactionBeacon } from './TransactionBeacon'
import { ComparisonMarkers } from './ComparisonMarkers'
import { art, type Quality, type View } from '../config/art'
import type { ReserveProps } from './Reserve'
import { PlayableReserve } from './PlayableReserve'
import { IslandContainer } from './IslandContainer'
import { ReserveCloud } from './ReserveCloud'
import { createReserveInteraction, type ReserveInteraction } from './reserveInteraction'
import { GOLD, type Transaction } from '../domain/reserve'
import { INSTANCE_LIMIT } from '../domain/comparison'
import { environmentMaterial } from './coastalMaterials'
import { IslandDetails, PalmCanopies } from './IslandDetails'
import { coastalShoreline } from './coastalShoreline'

export interface SceneStats { calls: number; triangles: number; fps: number; geometries: number; quality: Quality }
export interface SceneProps extends ReserveProps {
  transactions: Transaction[]; resetRevision: number
  comparing: boolean; comparisonAmount: number; comparisonVisible: boolean; comparisonArrived: boolean; skipRevision: number
  onCameraStatus: (status: CameraStatus) => void
  quality: Quality; reduced: boolean; rotating: boolean
  view: { name: View; revision: number }; active: boolean
  onReady: () => void; onStats: (stats: SceneStats) => void; onContextLost: () => void; onFailure: () => void
}

function prepared(scene: Group, time: { value: number }) {
  const clone = scene.clone(true)
  clone.traverse(object => {
    if (object instanceof Mesh) {
      if (/Palm.?leaf/.test(object.name + object.parent?.name)) { object.visible = false; return }
      object.castShadow = true
      object.receiveShadow = true
      const materials = (Array.isArray(object.material) ? object.material : [object.material]).map(material => material instanceof MeshStandardMaterial ? environmentMaterial(material, time) : material.clone())
      object.material = Array.isArray(object.material) ? materials : materials[0]
    }
  })
  return clone
}

function World({ onReady, interaction, ...props }: SceneProps & { interaction: RefObject<ReserveInteraction> }) {
  const { gl, scene, camera } = useThree()
  const gltf = useLoader(GLTFLoader, '/generated/island-study.glb')
  const waterTime = useMemo(() => ({ value: 0 }), [])
  const environment = useMemo(() => prepared(gltf.scene, waterTime), [gltf, waterTime])
  const shoreline = useMemo(() => coastalShoreline(gltf.scene), [gltf])
  const groundHeight = useMemo(() => {
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
  useEffect(() => () => environment.traverse(object => {
    if (object instanceof Mesh && !/Palm.?leaf/.test(object.name + object.parent?.name)) (Array.isArray(object.material) ? object.material : [object.material]).forEach(material => material.dispose())
  }), [environment])
  useEffect(() => {
    let cancelled = false
    const frame = requestAnimationFrame(() => { void gl.compileAsync(scene, camera).then(() => { if (!cancelled) onReady() }).catch(props.onFailure) })
    return () => { cancelled = true; cancelAnimationFrame(frame) }
  }, [gl, scene, camera, onReady, props.onFailure])
  useEffect(() => { gl.shadowMap.needsUpdate = true }, [gl, props.amount, props.quality, props.transaction, props.comparisonVisible, props.comparisonAmount])
  useFrame(() => { if (props.transaction) gl.shadowMap.needsUpdate = true })
  return <>
    <primitive object={environment} dispose={null} />
    <IslandContainer reduced={props.reduced} shoreline={shoreline} time={waterTime} />
    <ReserveCloud reduced={props.reduced} activity={props.transaction?.type === 'income' ? 1 : 0} />
    <IslandDetails reduced={props.reduced} groundHeight={groundHeight} /><PalmCanopies reduced={props.reduced} />
    <PlayableReserve reduced={props.reduced} amount={props.amount} transaction={props.transaction} transactions={props.transactions} resetRevision={props.resetRevision}
      interaction={interaction} disabled={props.comparisonVisible || !props.active} onComplete={props.onComplete} onPhase={props.onPhase} />
    <ComparisonReserve reduced={props.reduced || !props.active} amount={props.comparisonAmount}
      visible={props.comparisonVisible} arrivalReady={props.comparisonArrived && props.active} />
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.76, 0]} receiveShadow>
      <planeGeometry args={[200, 200]} />
      <shadowMaterial color="#355e69" opacity={.2} />
    </mesh>
  </>
}

export function IslandScene(props: SceneProps) {
  const interaction = useRef(createReserveInteraction())
  const comparisonShadow = props.comparisonVisible && props.comparisonAmount <= INSTANCE_LIMIT * GOLD
  return <Canvas shadows={props.quality === 'high'} dpr={props.quality === 'high' ? [1, 1.35] : 1}
    frameloop={props.active ? 'always' : 'never'}
    camera={{ position: art.camera.home, fov: 39, near: .2, far: 160 }}
    gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
    onCreated={({ gl }) => { gl.toneMapping = ACESFilmicToneMapping; gl.toneMappingExposure = art.exposure; gl.outputColorSpace = SRGBColorSpace; gl.shadowMap.type = PCFSoftShadowMap; gl.shadowMap.autoUpdate = false; gl.shadowMap.needsUpdate = true }}
    fallback={<span>浏览器不支持三维画布，请使用支持 WebGL 的浏览器。</span>}>
    <hemisphereLight args={[art.ambient.sky, art.ambient.ground, art.ambient.intensity]} />
    <directionalLight position={comparisonShadow ? [-12, 27, 18] : art.sun.position} intensity={art.sun.intensity} color={art.sun.color}
      onUpdate={light => light.shadow.camera.updateProjectionMatrix()}
      castShadow={props.quality === 'high'} shadow-mapSize={[2048, 2048]}
      shadow-camera-left={comparisonShadow ? -26.9 : -9} shadow-camera-right={comparisonShadow ? 12.4 : 9}
      shadow-camera-top={comparisonShadow ? 13.7 : 9} shadow-camera-bottom={comparisonShadow ? -18.4 : -9}
      shadow-camera-near={comparisonShadow ? 15.4 : .5} shadow-camera-far={comparisonShadow ? 44.1 : 30}
      shadow-bias={-.00008} shadow-normalBias={.008} shadow-radius={3} />
    <directionalLight position={[6, 5, -6]} intensity={.6} color="#b5dce9" />
    <Suspense fallback={null}><World {...props} interaction={interaction} /></Suspense>
    <CameraRig {...props} interaction={interaction} />
    <TransactionBeacon transaction={props.comparisonVisible ? null : props.transaction} />
    <ComparisonMarkers amount={props.comparisonAmount} visible={props.comparisonVisible} large={false} />
  </Canvas>
}
