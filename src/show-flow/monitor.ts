/**
 * 双 PPT 合成监控 · 播放端截图上传
 *
 * 联动放映时，主屏(ShowFlowConsole)与副屏(/secondary)各自将当前页画面截图，
 * 上传到 /monitor-api/screen/{main|secondary}；服务端合成 1280×800
 * （主屏左 640×800 + 副屏右 640×800，叠加当前页/总页角标）并提供
 * HTTP 下载(/monitor-api/display) 与 MQTT 消息（结构与 LED 四屏协议一致）。
 */
import { toPng } from 'html-to-image'

const FALLBACK_TOPIC = 'presentation/led/display'

/** 截取元素画面并按角色上传合成；成功后主屏侧会按服务端返回的 topic 发布 MQTT */
export async function captureAndUploadHalf(
  role: 'main' | 'secondary',
  el: Element,
  page: number,
  total: number,
): Promise<boolean> {
  try {
    const dataUrl = await toPng(el as HTMLElement, { pixelRatio: 1.2 })
    const response = await fetch(`/monitor-api/screen/${role}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page, total, image: dataUrl }),
    })
    if (!response.ok) return false
    const result = await response.json() as {
      ok?: boolean; revision?: number; url?: string; sha256?: string
      mqttTopic?: string; mainPage?: string | null; secondaryPage?: string | null
    }
    if (role === 'main') {
      // MQTT 消息结构与 LED 四屏协议一致（led-display/1.0），板端可直接复用解析；
      // retain 发布使监控端「初次打开」即可获得当前合成画面
      const { publishPresentationMqtt } = await import('@/utils/presentation/bridge')
      publishPresentationMqtt(result.mqttTopic || FALLBACK_TOPIC, {
        protocol: 'led-display/1.0',
        type: 'display',
        msg_id: `monitor-${result.revision ?? 0}`,
        revision: result.revision ?? 0,
        role: 'dual',
        image: {
          url: new URL('/monitor-api/display', location.origin).href,
          format: 'jpeg',
          width: 1280,
          height: 800,
          sha256: result.sha256 || '',
        },
        mainPage: result.mainPage ?? undefined,
        secondaryPage: result.secondaryPage ?? undefined,
      })
    }
    return true
  }
  catch {
    return false
  }
}
