import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Box3, InstancedMesh, Matrix4, Mesh, PerspectiveCamera, Vector3, type BufferGeometry, type Object3D } from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { art, type View } from '../config/art'
import { comparisonLayout } from '../domain/comparison'
import type { SceneProps } from './IslandScene'
import type { ReserveInteraction } from './reserveInteraction'

export type CameraStatus = 'island' | 'outbound' | 'comparing' | 'returning'
type Pose = { position: Vector3; target: Vector3; near: number; far: number }
type Flight = { from: Pose; to: Pose; elapsed: number; duration: number; returning: boolean; normal?: boolean }

export function CameraRig({ view, rotating, reduced, active, onStats, onContextLost, quality, transaction, amount,
  comparing, comparisonAmount, skipRevision, onCameraStatus, interaction }: SceneProps & { interaction: RefObject<ReserveInteraction> }) {
  const { camera: rawCamera, gl, invalidate, size, scene } = useThree()
  const camera = rawCamera as PerspectiveCamera
  const large = false
  const directions = useRef({ from: new Vector3(), to: new Vector3(), result: new Vector3() })
  const controls = useRef<OrbitControls | null>(null)
  const saved = useRef<Pose | null>(null)
  const previousLarge = useRef(large)
  const flight = useRef<Flight | null>(null)
  const mode = useRef<CameraStatus>('island')
  const comparisonMinDistance = useRef(1)
  const frameMs = useRef<number[]>([])
  const stat = useRef({ elapsed: 0, frames: 0 })
  const aspect = useRef(size.width / size.height)
  aspect.current = size.width / size.height
  const status = useCallback((next: CameraStatus) => { mode.current = next; onCameraStatus(next) }, [onCameraStatus])
  const finish = useCallback(() => {
    const moving = flight.current, orbit = controls.current
    if (!moving || !orbit) return
    camera.position.copy(moving.to.position)
    orbit.target.copy(moving.to.target)
    camera.near = moving.to.near; camera.far = moving.to.far; camera.updateProjectionMatrix()
    orbit.minDistance = moving.returning ? (large ? 22 : art.camera.minDistance) : comparisonMinDistance.current
    orbit.maxDistance = moving.returning ? (large ? 140 : art.camera.maxDistance) : Math.max(100, camera.position.distanceTo(orbit.target) * 3)
    orbit.enabled = true
    orbit.update()
    flight.current = null
    if (moving.returning && !moving.normal) saved.current = null
    status(moving.returning ? 'island' : 'comparing')
    invalidate()
  }, [camera, invalidate, status, large])

  useEffect(() => {
    const orbit = new OrbitControls(camera, gl.domElement)
    orbit.target.set(...art.camera.target)
    orbit.enablePan = false; orbit.enableDamping = true; orbit.dampingFactor = .085
    orbit.minDistance = art.camera.minDistance; orbit.maxDistance = art.camera.maxDistance
    orbit.minPolarAngle = .25; orbit.maxPolarAngle = Math.PI / 2.65
    orbit.autoRotateSpeed = .55; orbit.rotateSpeed = .65; orbit.zoomSpeed = .75
    controls.current = orbit
    interaction.current.orbit = orbit
    let pointer: { id: number; x: number; y: number; at: number } | null = null
    const down = (event: PointerEvent) => {
      if (event.button === 0 && orbit.enabled && mode.current === 'island' && !interaction.current.dragging)
        pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, at: event.timeStamp }
    }
    const move = (event: PointerEvent) => {
      if (event.pointerType === 'mouse' && !(event.buttons & 1)) { pointer = null; return }
      if (!pointer || pointer.id !== event.pointerId || interaction.current.dragging || !orbit.enabled || mode.current !== 'island') return
      const dx = event.clientX - pointer.x, dy = event.clientY - pointer.y
      const speed = Math.min(1.3, Math.hypot(dx, dy) / Math.max(8, event.timeStamp - pointer.at))
      const force = .009 * speed
      const e = camera.matrixWorld.elements
      interaction.current.nudge?.([(e[0] * dx - e[8] * dy) * force, (e[2] * dx - e[10] * dy) * force])
      pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, at: event.timeStamp }
    }
    const up = () => { pointer = null }
    gl.domElement.addEventListener('pointerdown', down)
    gl.domElement.addEventListener('pointermove', move)
    gl.domElement.addEventListener('pointerup', up)
    gl.domElement.addEventListener('pointercancel', up)
    gl.domElement.addEventListener('lostpointercapture', up)
    window.addEventListener('blur', up)
    const lost = (event: Event) => { event.preventDefault(); onContextLost() }
    gl.domElement.addEventListener('webglcontextlost', lost)
    return () => {
      interaction.current.release?.(); interaction.current.orbit = null
      orbit.dispose(); controls.current = null
      gl.domElement.removeEventListener('webglcontextlost', lost)
      gl.domElement.removeEventListener('pointerdown', down)
      gl.domElement.removeEventListener('pointermove', move)
      gl.domElement.removeEventListener('pointerup', up)
      gl.domElement.removeEventListener('pointercancel', up)
      gl.domElement.removeEventListener('lostpointercapture', up)
      window.removeEventListener('blur', up)
    }
  }, [camera, gl, onContextLost, interaction])

  // A resize changes the projection, never the user's chosen island position.
  useEffect(() => {
    const orbit = controls.current
    if (!orbit || saved.current) return
    const positions: Record<View, [number, number, number]> = {
      home: art.camera.home, front: [0, 11.5, 22], back: [-11, 11, -20], close: [3.9, 4.4, 7.7],
    }
    const from = { position: camera.position.clone(), target: orbit.target.clone(), near: camera.near, far: camera.far }
    const target = new Vector3(...(large ? [0, 2, 0] as [number, number, number] : view.name === 'close' ? [0, 1, 1.4] as [number, number, number] : art.camera.target))
    const position = new Vector3(...positions[view.name])
    if (large) position.multiplyScalar(view.name === 'close' ? 3 : 2.05)
    // Narrow screens keep the island large enough to read, with comfortable shore padding.
    if (view.name !== 'close') position.multiplyScalar(Math.max(1, .88 / aspect.current))
    orbit.autoRotate = false; orbit.enableDamping = false; orbit.update()
    camera.position.copy(from.position); orbit.target.copy(from.target); orbit.update(); orbit.enableDamping = true
    orbit.enabled = false
    flight.current = { from, to: { position, target, near: .2, far: large ? 400 : 160 }, duration: .85, elapsed: 0, returning: true, normal: true }
    invalidate()
  }, [view, camera, invalidate, large])

  useEffect(() => {
    const orbit = controls.current
    if (previousLarge.current !== large && saved.current) {
      saved.current = { position: new Vector3(...art.camera.home).multiplyScalar((large ? 2.05 : 1) * Math.max(1, .88 / aspect.current)), target: new Vector3(0, large ? 2 : .7, 0), near: .2, far: large ? 400 : 160 }
    }
    previousLarge.current = large
    if (!orbit || (!comparing && !saved.current)) return
    const from: Pose = { position: camera.position.clone(), target: orbit.target.clone(), near: camera.near, far: camera.far }
    if (comparing && !saved.current) saved.current = from
    // Flush pending input damping before taking ownership, then restore the exact pose.
    orbit.autoRotate = false; orbit.enableDamping = false; orbit.update()
    camera.position.copy(from.position); orbit.target.copy(from.target); orbit.update(); orbit.enableDamping = true
    orbit.enabled = false
    let to: Pose
    if (comparing) {
      const layout = comparisonLayout(comparisonAmount)
      const bounds = large ? new Box3(new Vector3(-18, -.75, -16), new Vector3(18, 10, 16)) : new Box3(new Vector3(-8.3, -.75, -8.3), new Vector3(8.3, 4.9, 8.3))
      bounds.expandByPoint(new Vector3(...layout.boundsMin)); bounds.expandByPoint(new Vector3(...layout.boundsMax))
      const target = bounds.getCenter(new Vector3()), radius = bounds.getSize(new Vector3()).length() / 2
      comparisonMinDistance.current = radius * 1.08
      const vertical = camera.fov * Math.PI / 360
      const halfFov = Math.min(vertical, Math.atan(Math.tan(vertical) * size.width / size.height))
      const distance = radius / Math.sin(halfFov) * 1.08
      to = { target, position: target.clone().add(new Vector3(.15, .55, 1.35).normalize().multiplyScalar(distance)), near: Math.max(.2, distance / 100), far: Math.max(160, distance * 5) }
    } else to = saved.current!
    const scaleTravel = Math.abs(Math.log(to.position.distanceTo(to.target) / from.position.distanceTo(from.target)))
    flight.current = { from, to, elapsed: 0, duration: Math.min(3.2, 1.25 + scaleTravel * .28), returning: !comparing }
    camera.near = Math.min(from.near, to.near); camera.far = Math.max(from.far, to.far); camera.updateProjectionMatrix()
    status(comparing ? 'outbound' : 'returning')
    invalidate()
  }, [comparing, comparisonAmount, camera, size.width, size.height, status, invalidate, large])

  useEffect(() => { if (reduced || !active) finish() }, [reduced, active, comparing, comparisonAmount, size.width, size.height, view, finish])
  useEffect(() => { if (skipRevision) finish() }, [skipRevision, finish])

  useEffect(() => {
    if (!import.meta.env.DEV) return
    const geometryFingerprints = new WeakMap<BufferGeometry, string>()
    const inspectMotion = () => {
      const root = scene.getObjectByName('comparisonReserve')
      const captured = new Set<string>()
      const instances: { kind: string; count: number; visible: boolean; matrices: number[][] }[] = []
      root?.traverse(object => {
        if (!(object instanceof InstancedMesh) || !(object.userData.comparisonGold || object.userData.comparisonSand)) return
        const kind = object.userData.comparisonSand ? 'sand' : 'gold'
        if (captured.has(kind)) return
        captured.add(kind)
        let visible = true
        for (let current: Object3D | null = object; current; current = current.parent) visible &&= current.visible
        const matrix = new Matrix4(), matrices: number[][] = []
        for (let index = 0; index < object.count; index++) {
          object.getMatrixAt(index, matrix); matrices.push(matrix.toArray())
        }
        instances.push({ kind, count: object.count, visible, matrices })
      })
      return { ...root?.userData, visible: root?.visible ?? false,
        active: mode.current !== 'island', transitioning: !!flight.current, instances }
    }
    const inspect = () => {
      const comparisonRoot = scene.getObjectByName('comparisonReserve')
      const isInside = (object: Object3D, root: Object3D | undefined) => {
        for (let current: Object3D | null = object; current; current = current.parent) if (current === root) return true
        return false
      }
      const visible = (object: Object3D) => {
        for (let current: Object3D | null = object; current; current = current.parent) if (!current.visible) return false
        return true
      }
      const comparisonEnvironments: Object3D[] = []
      scene.traverse(object => {
        if (object.name === 'comparisonEnvironment') comparisonEnvironments.push(object)
      })
      const comparisonEnvironment = comparisonEnvironments.find(visible) ?? comparisonEnvironments[0]
      const environmentOf = (object: Object3D) => {
        for (let current: Object3D | null = object; current; current = current.parent)
          if (current.name === 'comparisonEnvironment') return current
        return undefined
      }
      const matrixScale = (matrix: Matrix4) => [0, 4, 8].map(offset => Math.hypot(...matrix.elements.slice(offset, offset + 3)))
      const describeInstances = (mesh: InstancedMesh, role: string, kind: string) => {
        const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity]
        const matrix = new Matrix4()
        for (let index = 0; index < mesh.count; index++) {
          mesh.getMatrixAt(index, matrix)
          matrix.premultiply(mesh.matrixWorld)
          matrixScale(matrix).forEach((value, axis) => {
            minimum[axis] = Math.min(minimum[axis], value); maximum[axis] = Math.max(maximum[axis], value)
          })
        }
        return { uuid: mesh.uuid, role, kind, count: mesh.count, visible: visible(mesh),
          worldScaleMin: mesh.count ? minimum : null, worldScaleMax: mesh.count ? maximum : null }
      }
      const describeMesh = (mesh: Mesh, root?: Object3D) => {
        const relative = root ? new Matrix4().copy(root.matrixWorld).invert().multiply(mesh.matrixWorld) : mesh.matrixWorld
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
        const local = mesh.geometry.boundingBox!.clone().applyMatrix4(relative)
        const world = mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld)
        const projected: number[][] = []
        for (const x of [world.min.x, world.max.x]) for (const y of [world.min.y, world.max.y]) for (const z of [world.min.z, world.max.z]) {
          projected.push(new Vector3(x, y, z).project(camera).toArray())
        }
        const positions = mesh.geometry.getAttribute('position'), indices = mesh.geometry.index
        let fingerprint = geometryFingerprints.get(mesh.geometry)
        if (!fingerprint) {
          let hash = 2166136261
          for (let index = 0; index < positions.count; index++) {
            for (const value of [positions.getX(index), positions.getY(index), positions.getZ(index)]) {
              hash = Math.imul(hash ^ Math.round(value * 100000), 16777619)
            }
          }
          if (indices) for (let index = 0; index < indices.count; index++) hash = Math.imul(hash ^ indices.getX(index), 16777619)
          fingerprint = (hash >>> 0).toString(16)
          geometryFingerprints.set(mesh.geometry, fingerprint)
        }
        return { uuid: mesh.uuid, name: mesh.name, visible: visible(mesh), geometryUuid: mesh.geometry.uuid,
          geometryFingerprint: fingerprint, vertices: positions.count,
          triangles: (indices?.count ?? positions.count) / 3, relativeMatrix: relative.toArray(),
          boundsMin: local.min.toArray(), boundsMax: local.max.toArray(), worldScale: matrixScale(mesh.matrixWorld), projected }
      }
      const instanceMeshes: ReturnType<typeof describeInstances>[] = []
      const terrainMeshes: (ReturnType<typeof describeMesh> & { role: string })[] = []
      const containers: { role: string; uuid: string; visible: boolean; waterRadius: number; waterRadiusX: number; waterRadiusZ: number; worldScale: number[];
        surface: ReturnType<typeof describeMesh> | null }[] = []
      const envelopes: { visible: boolean; representedCount: number; layers: number; exteriorOnly: boolean;
        triangles: number; worldScale: number[] }[] = []
      const details: { role: string; name: string; visible: boolean; meshes: number }[] = []
      let actualInstances = 0, actualSandInstances = 0, actualUnitScale = 0
      const personal = { gold: 0, sand: 0, goldScale: 0, sandScale: 0 }
      scene.traverse(object => {
        if (object instanceof InstancedMesh && object.userData.personalReserve) {
          const inspected = describeInstances(object, 'personal', object.userData.personalReserveKind)
          instanceMeshes.push(inspected)
          if (object.userData.personalReserveKind === 'gold') {
            personal.gold = Math.max(personal.gold, object.count)
            if (object.count) personal.goldScale = inspected.worldScaleMin![0]
          } else {
            personal.sand = Math.max(personal.sand, object.count)
            if (object.count) personal.sandScale = inspected.worldScaleMin![0]
          }
        }
        if (object instanceof InstancedMesh && (object.userData.comparisonGold || object.userData.comparisonSand)) {
          const kind = object.userData.comparisonSand ? 'sand' : 'gold'
          const inspected = describeInstances(object, 'comparison', kind)
          instanceMeshes.push(inspected)
          if (kind === 'sand') actualSandInstances = Math.max(actualSandInstances, object.count)
          else { actualInstances = Math.max(actualInstances, object.count); if (object.count) actualUnitScale = inspected.worldScaleMin![0] }
        }
        const role = isInside(object, comparisonRoot) ? 'comparison' : 'personal'
        if (object instanceof Mesh && /Warm.?ivory.?sand/.test(object.name + object.parent?.name)) {
          terrainMeshes.push({ role, ...describeMesh(object, role === 'comparison' ? environmentOf(object) : undefined) })
        }
        if (object.userData.kind === 'reserve-container') {
          const surface = object.getObjectByName('Living coastal water surface')
          containers.push({ role, uuid: object.uuid, visible: visible(object), waterRadius: object.userData.waterRadius,
            waterRadiusX: object.userData.waterRadiusX, waterRadiusZ: object.userData.waterRadiusZ,
            worldScale: matrixScale(object.matrixWorld), surface: surface instanceof Mesh ? describeMesh(surface, object) : null })
        }
        if (object instanceof Mesh && object.geometry.userData.exteriorOnly) {
          envelopes.push({ visible: visible(object), representedCount: object.geometry.userData.representedCount,
            layers: object.geometry.userData.layers, exteriorOnly: object.geometry.userData.exteriorOnly,
            triangles: (object.geometry.index?.count ?? object.geometry.getAttribute('position').count) / 3,
            worldScale: matrixScale(object.matrixWorld) })
        }
        if (object.name === 'Island living details' || object.name === 'Feather palm crowns') {
          let meshes = 0
          object.traverse(child => { if (child instanceof Mesh) meshes++ })
          details.push({ role, name: object.name, visible: visible(object), meshes })
        }
      })
      const layout = comparisonLayout(comparisonAmount)
      return {
      camera: { position: camera.position.toArray(), target: controls.current?.target.toArray(), near: camera.near, far: camera.far },
      reserve: { amount, transactionId: transaction?.id ?? null },
      personal,
      comparison: { active: mode.current !== 'island', transitioning: !!flight.current, count: layout.count,
        actualInstances, actualSandInstances, actualUnitScale, islandRadii: [layout.radiusX, layout.radiusZ], layers: layout.layers.length, far: layout.far,
        environment: comparisonEnvironment ? { uuid: comparisonEnvironment.uuid, visible: visible(comparisonEnvironment),
          worldScale: matrixScale(comparisonEnvironment.matrixWorld), ...comparisonEnvironment.userData } : null,
        instances: instanceMeshes.filter(mesh => mesh.role === 'comparison'), envelopes, motion: inspectMotion() },
      islands: { terrainMeshes, containers, details },
      renderer: { ...gl.info.memory, calls: gl.info.render.calls, triangles: gl.info.render.triangles },
      frameMs: [...frameMs.current],
    } }
    const host = window as typeof window & { __islandInspect?: typeof inspect; __comparisonMotionInspect?: typeof inspectMotion }
    host.__islandInspect = inspect
    host.__comparisonMotionInspect = inspectMotion
    return () => {
      if (host.__islandInspect === inspect) delete host.__islandInspect
      if (host.__comparisonMotionInspect === inspectMotion) delete host.__comparisonMotionInspect
    }
  }, [camera, gl, scene, comparisonAmount, amount, transaction])

  useFrame((_, delta) => {
    const orbit = controls.current, moving = flight.current
    if (orbit && moving) {
      moving.elapsed += delta
      const t = Math.min(1, moving.elapsed / moving.duration), eased = t * t * t * (t * (t * 6 - 15) + 10)
      const fromDistance = moving.from.position.distanceTo(moving.from.target), toDistance = moving.to.position.distanceTo(moving.to.target)
      const distance = Math.exp(Math.log(fromDistance) + Math.log(toDistance / fromDistance) * eased)
      const travel = Math.abs(toDistance - fromDistance) < .001 ? eased : (distance - fromDistance) / (toDistance - fromDistance)
      orbit.target.lerpVectors(moving.from.target, moving.to.target, travel)
      const direction = directions.current
      direction.from.subVectors(moving.from.position, moving.from.target).normalize()
      direction.to.subVectors(moving.to.position, moving.to.target).normalize()
      direction.result.lerpVectors(direction.from, direction.to, eased).normalize()
      camera.position.copy(orbit.target).addScaledVector(direction.result, distance)
      camera.near = Math.exp(Math.log(moving.from.near) + Math.log(moving.to.near / moving.from.near) * eased)
      camera.updateProjectionMatrix()
      camera.lookAt(orbit.target)
      if (t === 1) finish()
    } else if (orbit) {
      orbit.autoRotate = rotating && !reduced && !transaction && !interaction.current.dragging && mode.current === 'island'
      if (!interaction.current.dragging) orbit.update()
    }
    if (import.meta.env.DEV) { frameMs.current.push(delta * 1000); if (frameMs.current.length > 300) frameMs.current.shift() }
    stat.current.elapsed += delta; stat.current.frames++
    if (stat.current.elapsed > 1.5) {
      onStats({ calls: gl.info.render.calls, triangles: gl.info.render.triangles, geometries: gl.info.memory.geometries,
        fps: Math.round(stat.current.frames / stat.current.elapsed), quality })
      stat.current = { elapsed: 0, frames: 0 }
    }
  })
  return null
}
