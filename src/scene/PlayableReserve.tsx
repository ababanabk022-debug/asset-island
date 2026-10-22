import { use, useEffect, useMemo, useRef, type RefObject } from 'react'
import { useFrame, useLoader, useThree } from '@react-three/fiber'
import { Color, Matrix4, MeshStandardMaterial, Plane, Quaternion, Raycaster, Vector2, Vector3 } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { GOLD, STONE, type Transaction } from '../domain/reserve'
import { FreeReservePhysics, physicsReady, type FreePiece } from './FreeReservePhysics'
import { SMALL_SCALE } from './reserveMotion'
import { prepareReserveAssets, reserveAssetsReady, RESERVE_CAPACITY } from './reserveAssets'
import { useReserveEnvironment } from './reserveEnvironment'
import { ReserveEffects } from './ReserveEffects'
import { soundEngine } from '../audio/soundEngine'
import { CONTAINER } from './containerConfig'
import type { ReserveProps } from './Reserve'
import type { ReserveInteraction } from './reserveInteraction'

interface Props extends ReserveProps {
  transactions: Transaction[]
  resetRevision: number
  interaction: RefObject<ReserveInteraction>
  disabled: boolean
}

export function PlayableReserve({ amount, transactions, resetRevision, onComplete, onPhase, reduced = false, interaction, disabled }: Props) {
  use(physicsReady)
  use(reserveAssetsReady)
  const models = useLoader(GLTFLoader, ['/generated/sandstone.glb', '/generated/gold.glb', '/generated/island-study.glb'])
  const { gl, camera, size } = useThree()
  const prepared = useMemo(() => prepareReserveAssets(models.map(model => model.scene)), [models])
  const materials = useMemo(() => prepared.parts.flatMap(({ mesh }) => Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as MeshStandardMaterial[], [prepared])
  useReserveEnvironment(gl, materials)
  const simulation = useRef<FreeReservePhysics | null>(null)
  const shown = useRef<FreePiece[]>([])
  const state = useRef({ revision: -1, reduced, lastId: '', acknowledged: '', phase: '', uploads: 0, commits: 0 })
  const ids = useRef(new Map<string, string[]>())
  const ingested = useRef(new Set<string>())
  const heard = useRef(new WeakSet<object>())
  const soundArmed = useRef(false)
  const effects = useMemo(() => new ReserveEffects(), [])
  const scratch = useMemo(() => ({ matrix: new Matrix4(), position: new Vector3(), scale: new Vector3(), quaternion: new Quaternion(), color: new Color() }), [])
  const drag = useRef<{ pointer: number; plane: Plane; offset: Vector3; orbitEnabled: boolean } | null>(null)

  useEffect(() => {
    const canvas = gl.domElement
    const ray = new Raycaster(), pointer = new Vector2(), point = new Vector3()
    const setRay = (event: PointerEvent) => {
      const bounds = canvas.getBoundingClientRect()
      pointer.set((event.clientX - bounds.left) / bounds.width * 2 - 1, -(event.clientY - bounds.top) / bounds.height * 2 + 1)
      ray.setFromCamera(pointer, camera)
    }
    const release = () => {
      const current = drag.current
      if (!current) return
      drag.current = null
      simulation.current?.endDrag()
      interaction.current.dragging = false
      if (interaction.current.orbit) interaction.current.orbit.enabled = current.orbitEnabled && !disabled
      if (canvas.hasPointerCapture(current.pointer)) canvas.releasePointerCapture(current.pointer)
      canvas.style.cursor = ''
    }
    const down = (event: PointerEvent) => {
      if (disabled || reduced || event.button !== 0 || !event.isPrimary || drag.current || !interaction.current.orbit?.enabled) return
      setRay(event)
      const hit = ray.intersectObjects(prepared.parts.map(part => part.mesh), false)[0]
      if (!hit || hit.instanceId === undefined) return
      const obstacle = ray.intersectObjects(prepared.occluders, false)[0]
      if (obstacle && obstacle.distance < hit.distance - .025) return
      const id = ids.current.get(hit.object.uuid)?.[hit.instanceId]
      const piece = shown.current.find(item => item.id === id && !item.spent)
      if (!piece) return
      const lift = Math.min(3.2, Math.max(.95, piece.position[1] + .85))
      const plane = new Plane(new Vector3(0, 1, 0), -lift)
      if (!ray.ray.intersectPlane(plane, point)) return
      const target = new Vector3(piece.position[0], lift, piece.position[2])
      if (!simulation.current?.startDrag(piece.id, target.toArray() as [number, number, number])) return
      soundArmed.current = true
      drag.current = { pointer: event.pointerId, plane, offset: target.sub(point), orbitEnabled: interaction.current.orbit.enabled }
      interaction.current.dragging = true
      interaction.current.orbit.enabled = false
      canvas.setPointerCapture(event.pointerId)
      canvas.style.cursor = 'grabbing'
      event.preventDefault(); event.stopImmediatePropagation()
    }
    const move = (event: PointerEvent) => {
      if (!drag.current) return
      if (event.pointerId !== drag.current.pointer) return
      setRay(event)
      if (ray.ray.intersectPlane(drag.current.plane, point)) {
        point.add(drag.current.offset)
        // The simulation projects this target into the real dry-shore contour
        // with the selected stone's own hull margin.
        simulation.current?.moveDrag(point.toArray() as [number, number, number])
      }
      event.preventDefault(); event.stopImmediatePropagation()
    }
    const up = (event: PointerEvent) => {
      if (!drag.current || event.pointerId !== drag.current.pointer) return
      release(); event.preventDefault(); event.stopImmediatePropagation()
    }
    interaction.current.release = release
    interaction.current.nudge = velocity => {
      if (!disabled && !reduced) { soundArmed.current = true; simulation.current?.nudge(velocity) }
    }
    canvas.addEventListener('pointerdown', down, true)
    canvas.addEventListener('pointermove', move, true)
    canvas.addEventListener('pointerup', up, true)
    canvas.addEventListener('pointercancel', up, true)
    canvas.addEventListener('lostpointercapture', release)
    window.addEventListener('blur', release)
    return () => {
      release()
      interaction.current.release = null; interaction.current.nudge = null
      canvas.removeEventListener('pointerdown', down, true)
      canvas.removeEventListener('pointermove', move, true)
      canvas.removeEventListener('pointerup', up, true)
      canvas.removeEventListener('pointercancel', up, true)
      canvas.removeEventListener('lostpointercapture', release)
      window.removeEventListener('blur', release)
    }
  }, [camera, gl, prepared, interaction, disabled, reduced])

  useEffect(() => {
    if (!import.meta.env.DEV) return
    const inspect = () => {
      const rect = gl.domElement.getBoundingClientRect()
      return {
        ...simulation.current?.metrics(), commits: state.current.commits, uploads: state.current.uploads,
        resetRevision: state.current.revision, container: CONTAINER, obstacleMeshes: prepared.assets.obstacles?.length,
        pieces: shown.current.map(piece => {
          const p = new Vector3(...piece.position).project(camera)
          return { ...piece, screen: [rect.x + (p.x + 1) * rect.width / 2, rect.y + (1 - p.y) * rect.height / 2], depth: p.z }
        }),
      }
    }
    const host = window as typeof window & { __reserveInspect?: typeof inspect }
    host.__reserveInspect = inspect
    return () => { if (host.__reserveInspect === inspect) delete host.__reserveInspect }
  }, [camera, gl, prepared, size])

  useEffect(() => () => {
    simulation.current?.dispose(); simulation.current = null
    prepared.parts.forEach(({ mesh }) => {
      mesh.geometry.dispose()
      ;(Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach(material => material.dispose())
      mesh.dispose()
    })
    effects.dispose()
    soundEngine.stop()
  }, [prepared, effects])

  useFrame((_, delta) => {
    let changed = false
    if (!simulation.current) {
      simulation.current = new FreeReservePhysics(prepared.assets, transactions[0]?.before ?? amount, reduced)
      state.current.revision = resetRevision
      changed = true
    }
    const sim = simulation.current
    if (state.current.revision !== resetRevision || state.current.reduced !== reduced) {
      interaction.current.release?.()
      sim.setReduced(reduced)
      sim.sync(amount)
      state.current.revision = resetRevision; state.current.reduced = reduced
      state.current.lastId = ''; state.current.acknowledged = ''
      ingested.current.clear()
      heard.current = new WeakSet()
      soundArmed.current = false
      soundEngine.stop(); effects.clear(); changed = true
    }
    if (!reduced) {
      for (const transaction of transactions) {
        if (ingested.current.has(transaction.id)) continue
        sim.commit(transaction)
        soundArmed.current = true
        ingested.current.add(transaction.id)
        state.current.commits++
        if (ingested.current.size > 256) ingested.current.delete(ingested.current.values().next().value!)
      }
      const latest = transactions.at(-1)
      if (latest && latest.id !== state.current.lastId) {
        state.current.lastId = latest.id
        changed = true
      }
    } else if (sim.interactionState().amount !== amount) { sim.sync(amount); changed = true }
    const moving = sim.isActive
    if (moving && !reduced && !disabled) sim.advance(delta)
    if (drag.current && !sim.interactionState().dragging) interaction.current.release?.()
    effects.update(disabled || reduced ? [] : sim.impacts, sim.time, camera.quaternion)
    if (!reduced && !disabled) for (const impact of sim.impacts) {
      if (heard.current.has(impact)) continue
      heard.current.add(impact)
      if (soundArmed.current) soundEngine.play(impact.effect ?? (impact.water ? 'water' : impact.gold ? 'gold' : 'stone'), impact.strength)
    }
    if (changed || moving) {
      gl.shadowMap.needsUpdate = true
      shown.current = sim.pieces()
      for (const { mesh, kind } of prepared.parts) {
        const instanceIds: string[] = []
        const fracture = mesh.geometry.getAttribute('fracture')
        for (const piece of shown.current) {
          if (piece.kind !== kind || piece.factor <= .00001) continue
          const count = instanceIds.length
          if (count >= RESERVE_CAPACITY) throw new Error('Reserve instance capacity exceeded')
          const scale = SMALL_SCALE * Math.cbrt(piece.value / (kind === 'gold' ? GOLD : STONE) * piece.factor)
          scratch.position.set(...piece.position); scratch.scale.setScalar(scale)
          if (piece.orientation) scratch.quaternion.fromArray(piece.orientation)
          else scratch.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), piece.rotation)
          scratch.matrix.compose(scratch.position, scratch.quaternion, scratch.scale)
          mesh.setMatrixAt(count, scratch.matrix); fracture.setX(count, piece.crack ?? 0)
          scratch.color.setScalar(kind === 'sand' ? .9 + count % 4 * .035 : 1)
          mesh.setColorAt(count, scratch.color)
          instanceIds.push(piece.id)
        }
        mesh.count = instanceIds.length; mesh.instanceMatrix.needsUpdate = true; fracture.needsUpdate = true
        // Raycasting caches an instanced bounding sphere. Bodies can travel far
        // beyond the first pile, so every changed pose must invalidate it.
        mesh.boundingSphere = null
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
        ids.current.set(mesh.uuid, instanceIds)
      }
      state.current.uploads++
    }
    const phase = sim.pending ? '云下的石头，正在来去' : interaction.current.dragging ? '松手，让石头自然落下' : '拖动石块，把积累握在手里'
    if (state.current.phase !== phase) { state.current.phase = phase; onPhase(phase) }
    if (state.current.lastId && !sim.pending && state.current.acknowledged !== state.current.lastId) {
      state.current.acknowledged = state.current.lastId
      onComplete(state.current.lastId)
    }
  })
  return <>{prepared.parts.map(({ mesh }) => <primitive key={mesh.uuid} object={mesh} dispose={null} />)}<primitive object={effects.group} dispose={null} /></>
}
