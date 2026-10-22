import { AdditiveBlending, Group, InstancedBufferAttribute, InstancedMesh, Matrix4, NormalBlending, PlaneGeometry, Quaternion, ShaderMaterial, Vector3 } from 'three'
import type { Impact } from './reservePhysics'

/** Two fixed GPU batches, driven by physical contact time rather than React state. */
export class ReserveEffects {
  group = new Group()
  private rings: InstancedMesh<PlaneGeometry, ShaderMaterial>
  private sparks: InstancedMesh<PlaneGeometry, ShaderMaterial>
  private matrix = new Matrix4()
  private position = new Vector3()
  private scale = new Vector3()
  private flat = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2)
  constructor() {
    const make = (spark: boolean) => {
      const geometry = new PlaneGeometry(1, 1)
      geometry.setAttribute('life', new InstancedBufferAttribute(new Float32Array(192), 1))
      geometry.setAttribute('warm', new InstancedBufferAttribute(new Float32Array(192), 1))
      const material = new ShaderMaterial({
        transparent: true, depthWrite: false, blending: spark ? AdditiveBlending : NormalBlending,
        vertexShader: 'attribute float life;attribute float warm;varying float a;varying float w;varying vec2 v;void main(){a=life;w=warm;v=uv;gl_Position=projectionMatrix*modelViewMatrix*instanceMatrix*vec4(position,1.);}',
        fragmentShader: `varying float a;varying float w;varying vec2 v;void main(){vec2 p=v-.5;float d=length(p)*2.;float shape=${spark ? 'pow(max(0.,1.-d),3.)+.3*exp(-50.*abs(p.x))*exp(-14.*abs(p.y))' : '(1.-smoothstep(.025,.10,abs(d-.76)))*(1.-smoothstep(.85,1.,d))'};gl_FragColor=vec4(mix(vec3(.88,.96,.91),vec3(1.,.75,.30),w),shape*a);\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}`,
      })
      const mesh = new InstancedMesh(geometry, material, 192)
      mesh.count = 0; mesh.frustumCulled = false; mesh.renderOrder = 3
      this.group.add(mesh)
      return mesh
    }
    this.rings = make(false); this.sparks = make(true)
  }
  update(impacts: Impact[], time: number, camera: Quaternion) {
    let rings = 0, sparks = 0
    const ringLife = this.rings.geometry.getAttribute('life'), ringWarm = this.rings.geometry.getAttribute('warm')
    const sparkLife = this.sparks.geometry.getAttribute('life'), sparkWarm = this.sparks.geometry.getAttribute('warm')
    for (const impact of impacts) {
      const age = time - impact.time, feature = !!impact.effect
      const duration = feature ? .48 : impact.water ? .5 : .28
      if (age < 0 || age >= duration || rings >= 24) continue
      const p = age / duration, fade = (1 - p) ** 2
      if (feature || impact.water || impact.strength > .4) {
        this.position.set(impact.position[0], impact.position[1] + .035, impact.position[2])
        const radius = (feature ? .7 : .3) + Math.sqrt(p) * (feature ? 2.2 : .8)
        this.scale.setScalar(radius)
        this.rings.setMatrixAt(rings, this.matrix.compose(this.position, this.flat, this.scale))
        ringLife.setX(rings, fade * (feature ? .65 : .22)); ringWarm.setX(rings++, impact.gold ? .8 : .1)
      }
      if (!feature) continue
      for (let j = 0; j < 16 && sparks < 192; j++) {
        const angle = j * 2.39996
        const speed = .6 + (j % 5) * .18
        this.position.set(impact.position[0] + Math.cos(angle) * age * speed,
          impact.position[1] + .18 + age * (1.1 + j % 3 * .45) - 1.5 * age * age,
          impact.position[2] + Math.sin(angle) * age * speed)
        this.scale.setScalar((.075 + j % 3 * .025) * (1 - p * .65))
        this.sparks.setMatrixAt(sparks, this.matrix.compose(this.position, camera, this.scale))
        sparkLife.setX(sparks, fade * .85); sparkWarm.setX(sparks++, 1)
      }
    }
    this.rings.count = rings; this.sparks.count = sparks
    for (const mesh of [this.rings, this.sparks]) {
      mesh.instanceMatrix.needsUpdate = true
      mesh.geometry.getAttribute('life').needsUpdate = true
      mesh.geometry.getAttribute('warm').needsUpdate = true
    }
  }
  clear() { this.rings.count = 0; this.sparks.count = 0 }
  dispose() {
    for (const mesh of [this.rings, this.sparks]) { mesh.geometry.dispose(); mesh.material.dispose(); mesh.dispose() }
  }
}
