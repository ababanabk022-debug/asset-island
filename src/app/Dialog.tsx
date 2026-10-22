import { useEffect, useRef, type ReactNode } from 'react'
export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const node = ref.current!, previous = document.activeElement as HTMLElement | null
    node.showModal()
    return () => { node.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [])
  return <dialog ref={ref} className="sheet-dialog" onCancel={event => { event.preventDefault(); onClose() }} onClick={event => { if (event.target === ref.current) { const box = ref.current.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose() } }} aria-label={title}>
    <div className="sheet-heading"><h2>{title}</h2><button onClick={onClose} aria-label="关闭">×</button></div>{children}
  </dialog>
}
