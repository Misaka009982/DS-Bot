export interface ToolSummary {
  name: string
  label?: string | null
  ok?: boolean
  status?: string
  sessionId?: string
  callId?: string | null
  callSeq?: number | null
  turn?: number
}
export interface DetailPage {
  available: boolean
  text?: string
  reason?: string
  status?: string
  nextOffset?: number | null
  digest?: string
}
export interface TodoItem { id?: string; text: string; status: 'pending' | 'in_progress' | 'completed' | 'canceled' }
