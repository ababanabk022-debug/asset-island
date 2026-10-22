import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Vector3 } from 'three'
import { money, type Transaction } from '../domain/reserve'
import '../transaction-beacon.css'

/** A screen-space locator preserves the transaction's readability at any zoom
 * without changing represented volume or taking control of the camera. */
export function TransactionBeacon({ transaction }: { transaction: Transaction | null }) {
  const { gl, camera, size } = useThree()
  const element = useRef<HTMLDivElement>(null)
  const point = useMemo(() => new Vector3(), [])
  const host = gl.domElement.parentElement
  useEffect(() => {
    if (!host || !transaction) return
    const income = transaction.type === 'income'
    const node = document.createElement('div')
    node.className = `transaction-beacon ${income ? 'income' : 'expense'}`
    node.dataset.testid = 'transaction-beacon'
    node.style.visibility = 'hidden'
    const arrow = document.createElement('span')
    arrow.className = 'transaction-beacon-arrow'; arrow.setAttribute('aria-hidden', 'true'); arrow.textContent = income ? '↗' : '↙'
    const content = document.createElement('span'), label = document.createElement('small'), amount = document.createElement('strong')
    label.textContent = income ? '云下入账' : '支出离岛'
    amount.textContent = `${income ? '+' : '−'}¥${money(transaction.amount)}`
    content.append(label, amount)
    const pointer = document.createElement('i'); pointer.setAttribute('aria-hidden', 'true')
    node.append(arrow, content, pointer); host.append(node); element.current = node
    return () => { node.remove(); if (element.current === node) element.current = null }
  }, [host, transaction])
  useFrame(() => {
    const node = element.current
    if (!node || !transaction) return
    point.set(3.4, 2.3, 1.4).applyMatrix4(camera.matrixWorldInverse)
    // Points behind the camera cannot be assigned a meaningful locator.
    if (point.z >= 0 || size.width <= 0 || size.height <= 0) {
      node.style.visibility = 'hidden'
      return
    }
    point.applyMatrix4(camera.projectionMatrix)
    if (![point.x, point.y, point.z].every(Number.isFinite) || point.z < -1 || point.z > 1) {
      node.style.visibility = 'hidden'
      return
    }
    const halfWidth = node.offsetWidth / 2
    const height = node.offsetHeight
    const x = (point.x + 1) * size.width / 2
    const y = (1 - point.y) * size.height / 2 - 20
    const left = Math.max(halfWidth + 8, Math.min(size.width - halfWidth - 8, x))
    const top = Math.max(height + 8, Math.min(size.height - 24, y))
    node.style.transform = `translate3d(${left}px,${top}px,0) translate(-50%,-100%)`
    node.style.visibility = 'visible'
  })
  return null
}
