import { LCD_ROLES, type LcdRole, type LcdSceneState } from '../types.ts'

export const isLcdRole = (value: string): value is LcdRole =>
  (LCD_ROLES as readonly string[]).includes(value)

export function createLcdSceneState(
  source: LcdSceneState['source'],
  values: Record<string, string>,
): LcdSceneState {
  const lead = (values.lead || '').trim()
  const active = (values.active || '').split(',').map(v => v.trim()).filter(isLcdRole)
  return {
    source,
    stage: (values.stage || '').trim(),
    lead: isLcdRole(lead) ? lead : null,
    active,
    roles: Object.fromEntries(LCD_ROLES.map(role => [role, { task: (values[role] || '').trim() }])) as LcdSceneState['roles'],
  }
}
