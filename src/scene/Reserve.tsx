import { use, useEffect, useMemo, useRef } from 'react'
import { useFrame, useLoader, useThree } from '@react-three/fiber'
import { Box3, Color, InstancedBufferAttribute, InstancedMesh, Matrix4, Mesh, MeshStandardMaterial, PlaneGeometry, Quaternion, ShaderMaterial, Vector3 } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { useReserveEnvironment } from './reserveEnvironment'
import { GOLD, STONE, type Transaction } from '../domain/reserve'
import { makeMotion, restingPieces, SMALL_SCALE, type Piece } from './reserveMotion'
import { PHYSICS_SECONDS, physicsReady, ReservePhysics, type PhysicsAssets } from './reservePhysics'
import { ReserveEffects } from './ReserveEffects'
import { soundEngine } from '../audio/soundEngine'
import { sandstoneSurface } from './ReserveEffectsMaterials'

export interface ReserveProps { amount: number; transaction: Transaction | null; onComplete: (id: string) => void; onPhase: (phase: string) => void; reduced?: boolean }

export function Reserve({ amount, transaction, onComplete, onPhase, reduced = false }: ReserveProps) {
  use(physicsReady)
  const models = useLoader(GLTFLoader, ['/generated/sandstone.glb', '/generated/gold.glb', '/generated/island-study.glb'])
  const { gl, camera } = useThree()
  const lastPhase = useRef('')
  const simulation = useRef<ReservePhysics | null>(null)
  const shown = useRef<Piece[]>([])
  const lastId = useRef<string | null | undefined>(undefined)
  const lastAmount = useRef(-1)
  const lastReduced = useRef(reduced)
  const completed = useRef(false)
  const heard = useRef(new WeakSet<object>())
  const effects = useMemo(() => new ReserveEffects(), [])
  const prepared = useMemo(() => {
    const assets = {} as PhysicsAssets
    const terrainVertices: number[] = [], terrainIndices: number[] = []
    const parts: { mesh: InstancedMesh; kind: Piece['kind'] }[] = []
    models.forEach((gltf, index) => {
      gltf.scene.updateMatrixWorld(true)
      const bounds = new Box3().setFromObject(gltf.scene)
      const centerY = (bounds.max.y + bounds.min.y) / 2
      gltf.scene.traverse(object => {
        if (!(object instanceof Mesh)) return
        if (index === 2 && !/Warm.?ivory.?sand/.test(object.name + object.parent?.name)) return
        const geometry = object.geometry.clone().applyMatrix4(object.matrixWorld)
        if (index === 2) {
          const offset = terrainVertices.length / 3
          terrainVertices.push(...geometry.attributes.position.array)
          terrainIndices.push(...Array.from(geometry.index!.array, n => Number(n) + offset))
          geometry.dispose(); return
        }
        geometry.translate(0, -centerY, 0)
        geometry.setAttribute('fracture', new InstancedBufferAttribute(new Float32Array(440), 1))
        const kind = index === 0 ? 'sand' : 'gold'
        assets[kind] = { vertices: new Float32Array([...(assets[kind]?.vertices ?? []), ...geometry.attributes.position.array]), centerY }
        const materials = (Array.isArray(object.material) ? object.material : [object.material]).map(material => {
          const clone = material.clone() as MeshStandardMaterial
          clone.envMapIntensity = kind === 'gold' ? .55 : .07
          if (kind === 'sand') sandstoneSurface(clone)
          else { clone.roughness = Math.max(.34, clone.roughness); clone.metalness = .78 }
          const surfaceShader = clone.onBeforeCompile
          clone.onBeforeCompile = (shader, renderer) => {
            surfaceShader.call(clone, shader, renderer)
            shader.vertexShader = 'attribute float fracture; varying float vFracture; varying vec3 vRock;\n' + shader.vertexShader
            shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvFracture=fracture; vRock=position;')
            shader.fragmentShader = 'varying float vFracture; varying vec3 vRock;\n' + shader.fragmentShader
            shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\nfloat seam=min(abs(vRock.x+.13*sin(vRock.y*9.)+.07*sin(vRock.z*15.)),abs(vRock.z-.12*sin(vRock.x*10.)+.3*vRock.y)); float fissure=(1.-smoothstep(.006,.012+.025*vFracture,seam))*vFracture; diffuseColor.rgb=mix(diffuseColor.rgb,vec3(.055,.025,.009),fissure);')
          }
          clone.customProgramCacheKey = () => `reserve-fracture-v2-${kind}`
          return clone
        })
        const mesh = new InstancedMesh(geometry, Array.isArray(object.material) ? materials : materials[0], 440)
        // Compile the instanced-color variant during scene preparation, even
        // when no gold exists yet. First conversion must not compile a shader.
        mesh.setColorAt(0, new Color(1, 1, 1))
        mesh.count = 0; mesh.castShadow = true; mesh.receiveShadow = true; mesh.frustumCulled = false
        parts.push({ mesh, kind })
      })
    })
    if (!terrainIndices.length) throw new Error('Island collision surface missing')
    assets.terrain = { vertices: new Float32Array(terrainVertices), indices: new Uint32Array(terrainIndices) }
    return { assets, parts }
  }, [models])
  const environmentMaterials = useMemo(() => prepared.parts.flatMap(({ mesh }) => Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as MeshStandardMaterial[], [prepared])
  useReserveEnvironment(gl, environmentMaterials)
  const dust = useMemo(() => {
    const geometry = new PlaneGeometry(1, 1)
    geometry.setAttribute('opacity', new InstancedBufferAttribute(new Float32Array(720), 1))
    geometry.setAttribute('water', new InstancedBufferAttribute(new Float32Array(720), 1))
    const material = new ShaderMaterial({ transparent: true, depthWrite: false,
      uniforms: { uDust: { value: new Color('#bca47a') }, uWater: { value: new Color('#e1fff6') } },
      vertexShader: 'attribute float opacity; attribute float water; varying vec2 vUv; varying float vAlpha; varying float vWater; void main(){ vUv=uv;vAlpha=opacity;vWater=water;gl_Position=projectionMatrix*modelViewMatrix*instanceMatrix*vec4(position,1.);}',
      fragmentShader: 'uniform vec3 uDust; uniform vec3 uWater; varying vec2 vUv; varying float vAlpha; varying float vWater; void main(){float d=length(vUv-.5)*2.;float a=exp(-d*d*5.)*(1.-smoothstep(.6,1.,d))*vAlpha;gl_FragColor=vec4(mix(uDust,uWater,vWater),a);\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}',
    })
    const mesh = new InstancedMesh(geometry, material, 720)
    mesh.count = 0; mesh.frustumCulled = false; mesh.renderOrder = 2
    return mesh
  }, [])
  const scratch = useMemo(() => ({ matrix: new Matrix4(), position: new Vector3(), scale: new Vector3(), quaternion: new Quaternion(), axis: new Vector3(0, 1, 0), color: new Color() }), [])
  useEffect(() => () => {
    simulation.current?.dispose(); simulation.current = null
    prepared.parts.forEach(({ mesh }) => { mesh.geometry.dispose(); (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach(m => m.dispose()); mesh.dispose() })
    dust.geometry.dispose(); dust.material.dispose(); dust.dispose()
    effects.dispose()
    soundEngine.stop()
  }, [prepared, dust, effects])
  useFrame((_, delta) => {
    const id = transaction?.id ?? null
    const changed = !simulation.current || lastId.current !== id || lastAmount.current !== amount || lastReduced.current !== reduced
    if (changed) {
      soundEngine.stop()
      heard.current = new WeakSet()
      // Carry actual resting poses across transactions. Skip/reload rebuilds only
      // from committed money, so no late physics callback can change the ledger.
      const old = simulation.current
      const initial = shown.current.length ? shown.current : restingPieces(transaction?.before ?? amount)
      if (reduced) {
        // Reduced motion is a static committed denomination layout. Do not
        // advance or synchronously pre-roll a physics world to get this view.
        if (old) old.reset(restingPieces(amount))
        else simulation.current = new ReservePhysics(prepared.assets, restingPieces(amount))
      }
      else if (transaction) {
        if (old) old.reset(initial, makeMotion(transaction))
        else simulation.current = new ReservePhysics(prepared.assets, initial, makeMotion(transaction))
      }
      else if (!old || !completed.current || lastAmount.current !== amount) {
        if (old) old.reset(restingPieces(amount))
        else simulation.current = new ReservePhysics(prepared.assets, restingPieces(amount))
      }
      if (simulation.current !== old) old?.dispose()
      lastId.current = id; lastAmount.current = amount; lastReduced.current = reduced; completed.current = false; lastPhase.current = ''
    }
    const sim = simulation.current!
    // Settled buffers stay on the GPU until money changes. No pose allocations,
    // instance uploads or dust work are needed while merely orbiting the island.
    if (!changed && (reduced || sim.time >= PHYSICS_SECONDS)) { effects.clear(); dust.count = 0; return }
    // Initial load, skipped transactions and imported balances also settle
    // without an active transaction; their shadows must follow until rest.
    gl.shadowMap.needsUpdate = true
    if (!reduced) {
      sim.advance(delta)
      effects.update(sim.impacts, sim.time, camera.quaternion)
    } else { effects.clear(); dust.count = 0 }
    if (transaction && !reduced) for (const impact of sim.impacts) {
      if (heard.current.has(impact)) continue
      heard.current.add(impact)
      // Process the physical contact once; replaying a buffered impact every
      // render frame would create a harsh buzz and unbounded audio voices.
      soundEngine.play(impact.effect ?? (impact.water ? 'water' : impact.gold ? 'gold' : 'stone'), impact.strength)
    }
    shown.current = sim.pieces(!reduced)
    for (const { mesh, kind } of prepared.parts) {
      let count = 0
      const fracture = mesh.geometry.getAttribute('fracture')
      for (const piece of shown.current) {
        if (piece.kind !== kind || piece.factor <= .00001) continue
        const scale = SMALL_SCALE * Math.cbrt(piece.value / (kind === 'gold' ? GOLD : STONE) * piece.factor)
        scratch.position.set(...piece.position); scratch.scale.setScalar(scale)
        if (piece.orientation) scratch.quaternion.fromArray(piece.orientation)
        else scratch.quaternion.setFromAxisAngle(scratch.axis, piece.rotation)
        scratch.matrix.compose(scratch.position, scratch.quaternion, scratch.scale)
        mesh.setMatrixAt(count, scratch.matrix)
        fracture.setX(count, piece.crack ?? 0)
        scratch.color.setScalar(kind === 'sand' ? .88 + (count % 4) * .04 : 1)
        mesh.setColorAt(count++, scratch.color)
      }
      mesh.count = count; mesh.instanceMatrix.needsUpdate = true
      fracture.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    }
    let count = 0
    const opacity = dust.geometry.getAttribute('opacity'), water = dust.geometry.getAttribute('water')
    for (const impact of sim.impacts) {
      const age = sim.time - impact.time
      for (let j = 0; j < 12 && count < 720; j++) {
        const angle = j * 2.39996, speed = .35 + (j % 4) * .16
        const fade = Math.max(0, 1 - age / (impact.water ? .45 : .5))
        scratch.position.set(impact.position[0] + Math.cos(angle) * age * speed,
          impact.position[1] + .035 + (impact.water ? Math.max(0, age * (1.4 + j % 3 * .2) - 2.8 * age ** 2) : age * (.12 + j % 3 * .06)),
          impact.position[2] + Math.sin(angle) * age * speed)
        scratch.scale.setScalar(impact.water ? .045 + age * .07 : (.10 + age * .42) * impact.strength)
        scratch.matrix.compose(scratch.position, camera.quaternion, scratch.scale)
        dust.setMatrixAt(count, scratch.matrix); opacity.setX(count, fade * (impact.water ? .8 : .19)); water.setX(count, impact.water ? 1 : 0); count++
      }
    }
    dust.count = count; dust.instanceMatrix.needsUpdate = true; opacity.needsUpdate = true; water.needsUpdate = true
    const phase = sim.phase()
    if (phase !== lastPhase.current) { lastPhase.current = phase; onPhase(phase) }
    if (transaction && (reduced || sim.time >= PHYSICS_SECONDS) && !completed.current) { completed.current = true; onComplete(transaction.id) }
  })
  return <>{prepared.parts.map(({ mesh }, i) => <primitive key={i} object={mesh} dispose={null} />)}<primitive object={dust} dispose={null} /><primitive object={effects.group} dispose={null} /></>
}
