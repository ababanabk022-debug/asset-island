import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Vector3 } from 'three'
import { comparisonLayout, MUSK_SNAPSHOT } from '../domain/comparison'
import { money } from '../domain/reserve'

export function ComparisonMarkers({ amount, visible, large = false }: { amount: number; visible: boolean; large?: boolean }) {
  const { gl, camera, size } = useThree()
  const own = useRef<HTMLDivElement>(null), example = useRef<HTMLDivElement>(null)
  const point = useMemo(() => new Vector3(), [])
  const edgePoint = useMemo(() => new Vector3(), [])
  const layout = useMemo(() => comparisonLayout(amount), [amount])
  const host = gl.domElement.parentElement
  useEffect(() => {
    if (!host || !visible) return
    const createMarker = (kind: 'own' | 'example', title: string, caption: string) => {
      const node = document.createElement('div')
      node.className = `comparison-world-marker ${kind}`
      node.dataset.testid = `comparison-${kind}-marker`
      node.style.visibility = 'hidden'
      const label = document.createElement('span'), detail = document.createElement('small')
      label.textContent = title; detail.textContent = caption
      node.append(label, detail); host.append(node)
      return node
    }
    const ownNode = createMarker('own', '我的储备', '小岛仍在这里')
    const exampleNode = createMarker('example', amount === MUSK_SNAPSHOT.amount ? '马斯克 · 历史估值' : '对比岛', amount === MUSK_SNAPSHOT.amount ? '约 ¥5.81 万亿' : `¥${money(amount).replace(/\.00$/, '')}`)
    own.current = ownNode; example.current = exampleNode
    return () => {
      ownNode.remove(); exampleNode.remove()
      if (own.current === ownNode) own.current = null
      if (example.current === exampleNode) example.current = null
    }
  }, [amount, host, visible])
  useFrame(() => {
    if (!visible) return
    const anchors = [{ node: own.current, anchor: [0, -.7, 0], radii: large ? [18, 15.6] : [8.3, 8.3] }, { node: example.current, anchor: [layout.position[0], .065, 0], radii: [layout.radiusX, layout.radiusZ] }]
    for (const { node, anchor, radii } of anchors) {
      if (!node) continue
      point.set(anchor[0], anchor[1], anchor[2]).applyMatrix4(camera.matrixWorldInverse)
      if (point.z >= 0 || size.width <= 0 || size.height <= 0) { node.style.visibility = 'hidden'; continue }
      point.applyMatrix4(camera.projectionMatrix)
      if (![point.x, point.y, point.z].every(Number.isFinite) || point.z < -1 || point.z > 1) { node.style.visibility = 'hidden'; continue }
      const halfWidth = node.offsetWidth / 2
      const x = Math.max(halfWidth + 10, Math.min(size.width - halfWidth - 10, (point.x + 1) * size.width / 2))
      let bottom = (1 - point.y) * size.height / 2
      // Put labels below the projected shoreline rather than over the assets.
      for (let i = 0; i < 24; i++) {
        const angle = i / 24 * Math.PI * 2
        edgePoint.set(anchor[0] + Math.cos(angle) * radii[0], anchor[1], Math.sin(angle) * radii[1]).project(camera)
        if (edgePoint.z > -1 && edgePoint.z < 1) bottom = Math.max(bottom, (1 - edgePoint.y) * size.height / 2)
      }
      const y = Math.max(30, Math.min(size.height - node.offsetHeight - 34, bottom + 22))
      node.style.transform = `translate3d(${x}px,${y}px,0) translateX(-50%)`
      node.style.visibility = 'visible'
    }
  })
  return null
}
