import { useEffect } from 'react'
import { PMREMGenerator, type MeshStandardMaterial, type WebGLRenderer, type WebGLRenderTarget } from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'

// All reserves share one reflection convolution per renderer. Reference counting
// also releases it when the Canvas leaves the page; StrictMode's effect replay
// can reacquire it before the deferred final disposal.
const environments = new WeakMap<WebGLRenderer, { target: WebGLRenderTarget; users: number }>()
export function useReserveEnvironment(gl: WebGLRenderer, materials: MeshStandardMaterial[]) {
  useEffect(() => {
    let entry = environments.get(gl)
    if (!entry) {
      const room = new RoomEnvironment(), generator = new PMREMGenerator(gl)
      const target = generator.fromScene(room, .06)
      room.dispose(); generator.dispose()
      entry = { target, users: 0 }; environments.set(gl, entry)
    }
    const acquired = entry
    acquired.users++
    materials.forEach(material => { material.envMap = acquired.target.texture; material.needsUpdate = true })
    return () => {
      materials.forEach(material => { material.envMap = null })
      acquired.users--
      queueMicrotask(() => {
        if (acquired.users === 0 && environments.get(gl) === acquired) {
          acquired.target.dispose(); environments.delete(gl)
        }
      })
    }
  }, [gl, materials])
}
