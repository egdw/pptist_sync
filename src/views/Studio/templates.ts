/**
 * ShowFlow Studio 页面排版模板库
 *
 * 每个模板提供：
 * - name：显示名称
 * - desc：适用场景说明
 * - build(stage)：返回该排版的完整页面 Markdown（含基础占位数据），
 *   新增后可直接用可视化表单继续修改。
 *
 * class 名与 theme.css 中的排版样式一一对应。
 */

export interface StudioTemplate {
  id: string
  name: string
  desc: string
  build: (stage: string) => string
}

/** 生成页面属性注释（四岗位默认协作数据，导入后可视化表单可改） */
function meta(cls: string, stage: string, extra: Record<string, string> = {}): string {
  const base: Record<string, string> = {
    'data-stage': stage,
    'data-active': 'manager,platform,twin,hardware',
    'data-role-detail':
      'manager=统筹本环节并汇报结论|对评委讲清整体进展;platform=执行平台侧操作并核对数据|保证数据真实可信;twin=准备仿真与三维内容|提供空间视角;hardware=操作车端与边缘设备|提供真实输入',
    'data-collab': 'manager=组织协调;platform=平台操作;twin=仿真/三维;hardware=车端操作',
    ...extra,
  }
  const attrs = [`class="${cls}"`, ...Object.entries(base).map(([k, v]) => `${k}="${v}"`)]
  return `<!-- .slide: ${attrs.join(' ')} -->`
}

const ul = (items: string[]) => items.map(t => `- **${t[0]}** ${t.slice(1)}`).join('\n')

export const STUDIO_TEMPLATES: StudioTemplate[] = [
  {
    id: 'team',
    name: '封面 / 团队',
    desc: '项目开场：标题 + 四岗位介绍',
    build: stage => `${meta('team', stage)}
# 页面标题
一句话副标题

| ![项目经理](portraits/manager.png) | ![平台系统开发工程师](portraits/platform.png) | ![数字孪生工程师](portraits/twin.png) | ![软硬件调试工程师](portraits/hardware.png) |
| --- | --- | --- | --- |
| 项目经理 | 平台系统开发工程师 | 数字孪生工程师 | 软硬件调试工程师 |
| 统筹推进 · 系统联通 | 黑匣子 · 存证 · 交警端 | 仿真验证 · 三维重建 · VR | 设备接入 · DMS · 实体测试 |`,
  },
  {
    id: 'problem',
    name: '问题分析',
    desc: '三个要点并列说明',
    build: stage => `${meta('problem', stage)}
# 页面标题（问题是什么）
一句补充说明

${ul(['要点一：说明', '要点二：说明', '要点三：说明'])}`,
  },
  {
    id: 'action',
    name: '操作演示',
    desc: '三列：操作 / 采集 / 显示',
    build: stage => `${meta('action', stage, {
      'data-lead': 'hardware',
      'data-cue': '现场操作发生时，对应数据卡实时高亮',
      'data-transition': 'slide',
    })}
# 页面标题（现场要做什么）
说明本环节核对目标

${ul(['现场操作：方向盘 / 油门 / 刹车', '实时采集：转角与踏板深度', '平台显示：黑匣子同步更新'])}`,
  },
  {
    id: 'compare',
    name: '对比表格',
    desc: '两列对照差异',
    build: stage => `${meta('compare', stage, { 'data-cue': '重点变化：两列结果存在差异' })}
# 页面标题（对比什么）
说明对比口径

| 正常情况 | 异常情况 |
| --- | --- |
| 操作 A | 操作 A |
| 预期结果 | 实际结果 |
| **结论一致** | **结论异常** |`,
  },
  {
    id: 'parallel',
    name: '双列并行',
    desc: '两条并行任务/内容',
    build: stage => `${meta('parallel', stage)}
# 页面标题（并行推进什么）
说明并行的两条线

${ul(['线路一：任务说明', '线路二：任务说明'])}`,
  },
  {
    id: 'timeline',
    name: '时间线',
    desc: '四步先后顺序',
    build: stage => `${meta('timeline', stage, { 'data-cue': '关键节点锁定后自动对齐时间轴' })}
# 页面标题（按时间推进）
说明时间轴口径

${ul(['第一步：说明', '第二步：说明', '第三步：说明', '第四步：说明'])}`,
  },
  {
    id: 'reasoning',
    name: '推理分析',
    desc: '三组证据支撑结论',
    build: stage => `${meta('reasoning', stage, { 'data-lead': 'manager', 'data-cue': '分析结果出现时，对应证据项同步高亮' })}
# 页面标题（得出什么结论）
说明结论由哪些证据支撑

${ul(['证据一：说明', '证据二：说明', '证据三：说明'])}`,
  },
  {
    id: 'evidence',
    name: '证据关联',
    desc: '三列证据同步调取',
    build: stage => `${meta('evidence', stage, { 'data-lead': 'platform', 'data-cue': '切换记录时，四类证据同步切换' })}
# 页面标题（关联哪些证据）
说明关联方式

${ul(['证据一：说明', '证据二：说明', '证据三：说明'])}`,
  },
  {
    id: 'results',
    name: '结果汇总表',
    desc: '多行结果数据表',
    build: stage => `${meta('results', stage, { 'data-cue': '本页数值支持实时更新，只显示本轮现场实测结果' })}
# 页面标题（验收 / 结果）

| 任务 | 结果 | 说明 |
| --- | --- | --- |
| 任务一 | 通过 | 备注说明 |
| 任务二 | 通过 | 备注说明 |
| 任务三 | 待测 | 备注说明 |`,
  },
  {
    id: 'scene',
    name: '场景展示',
    desc: '大图 + 两个要点',
    build: stage => `${meta('scene', stage, { 'data-lead': 'twin', 'data-transition': 'fade' })}
# 页面标题（展示什么场景）
说明场景意义

![场景配图](assets/scene-keyframe.svg)

${ul(['输入：说明', '输出：说明'])}`,
  },
  {
    id: 'closing',
    name: '收尾汇总',
    desc: '两条主线汇成闭环',
    build: stage => `${meta('closing', stage)}
# 页面标题（总结闭环）
说明整体成果

${ul(['主线一：成果说明', '主线二：成果说明'])}`,
  },
]
