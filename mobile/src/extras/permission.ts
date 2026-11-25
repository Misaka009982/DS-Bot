import { onPrefsChange, readPrefs, writePrefs } from '../store.ts'

const PREFIX = 'extras.permissions.'
export { permissionWrite } from './permission-policy.ts'
export async function permissionSwitch(hostKey: string): Promise<boolean> {
  return (await readPrefs())[PREFIX + hostKey] === 'on'
}
export async function setPermissionSwitch(hostKey: string, on: boolean): Promise<void> {
  await writePrefs({ [PREFIX + hostKey]: on ? 'on' : 'off' })
}
export { onPrefsChange }
