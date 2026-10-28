import { useEffect, useState } from 'react'

function readViewport() {
  const viewport = window.visualViewport
  return {
    left: viewport?.offsetLeft ?? 0,
    top: viewport?.offsetTop ?? 0,
    width: viewport?.width ?? window.innerWidth,
    height: viewport?.height ?? window.innerHeight,
  }
}

// Android's keyboard can resize the visible area without resizing the layout viewport.
export function useVisibleViewport() {
  const [viewport, setViewport] = useState(readViewport)
  useEffect(() => {
    const update = () => setViewport(readViewport())
    window.addEventListener('resize', update)
    window.visualViewport?.addEventListener('resize', update)
    window.visualViewport?.addEventListener('scroll', update)
    return () => {
      window.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('scroll', update)
    }
  }, [])
  return viewport
}
