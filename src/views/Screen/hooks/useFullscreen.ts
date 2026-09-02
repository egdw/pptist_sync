import { onMounted, onUnmounted, ref } from 'vue'
import { isFullscreen, exitFullscreen } from '@/utils/fullscreen'
import useScreening from '@/hooks/useScreening'

export default (options?: { exitScreeningOnEsc?: boolean }) => {
  // 播放页（打开即放映）传入 false：退出原生全屏仅退出全屏，不结束放映
  const exitScreeningOnEsc = options?.exitScreeningOnEsc !== false
  const fullscreenState = ref(true)
  const escExit = ref(true)

  const { exitScreening } = useScreening()

  const handleFullscreenChange = () => {
    fullscreenState.value = isFullscreen()
    if (!fullscreenState.value && escExit.value && exitScreeningOnEsc) exitScreening()

    escExit.value = true
  }

  onMounted(() => {
    fullscreenState.value = isFullscreen()
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange) // Safari 兼容
  })
  onUnmounted(() => {
    document.removeEventListener('fullscreenchange', handleFullscreenChange)
    document.removeEventListener('webkitfullscreenchange', handleFullscreenChange)
  })

  const manualExitFullscreen = () => {
    if (!fullscreenState.value) return
    escExit.value = false
    exitFullscreen()
  }

  return {
    fullscreenState,
    manualExitFullscreen,
  }
}