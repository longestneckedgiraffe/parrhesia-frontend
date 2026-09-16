import { config } from './config'

export class RoomAccessError extends Error {
  code: string

  constructor(message: string, code = '') {
    super(message)
    this.name = 'RoomAccessError'
    this.code = code
  }

  get canRetryPassword(): boolean {
    return ['password_required', 'auth_failed', 'auth_rate_limited', 'auth_unavailable'].includes(this.code)
  }
}

export function retryMessage(seconds: unknown): string {
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
    ? `Too many attempts. Try again in ${Math.ceil(seconds)} seconds.`
    : 'Too many attempts. Please try again later.'
}

function validatePassword(password: string): void {
  const normalized = password.normalize('NFC')
  const length = Array.from(normalized).length
  const encoder = new TextEncoder()
  if (length < 15 || length > 256 || encoder.encode(password).length > 1024 || encoder.encode(normalized).length > 1024) {
    throw new RoomAccessError('Password must contain 15–256 characters and at most 1024 UTF-8 bytes')
  }
}

async function responseError(response: Response, fallback: string): Promise<RoomAccessError> {
  if (response.status === 429) return new RoomAccessError(retryMessage(Number(response.headers.get('Retry-After'))))
  if (response.status === 503) return new RoomAccessError('Room access is temporarily unavailable. Please try again later.')
  if (response.status === 400) {
    const data = await response.json().catch(() => null)
    if (data?.error === 'This password is commonly used; choose a different passphrase') {
      return new RoomAccessError('This password is commonly used. Choose a different passphrase.')
    }
  }
  return new RoomAccessError(fallback)
}

export async function createRoom(password = ''): Promise<{ roomId: string; passwordRequired: boolean }> {
  if (password) validatePassword(password)
  const passwordRequired = password.length > 0
  let response: Response
  try {
    response = await fetch(config.endpoints.createRoom, {
      method: 'POST',
      cache: 'no-store',
      ...(passwordRequired ? {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      } : {})
    })
  } finally {
    password = ''
  }
  if (!response.ok) throw await responseError(response, 'Unable to create room')
  const data = await response.json()
  if (passwordRequired && data?.password_required !== true) {
    throw new RoomAccessError('The server did not confirm password protection. Room was not joined.')
  }
  if (typeof data?.room_id !== 'string' || !data.room_id) throw new RoomAccessError('Invalid room response')
  return { roomId: data.room_id, passwordRequired: data.password_required === true }
}

export async function checkRoom(roomId: string): Promise<{ exists: boolean; passwordRequired: boolean }> {
  const response = await fetch(config.endpoints.checkRoom(roomId), { cache: 'no-store' })
  if (response.status === 404) return { exists: false, passwordRequired: false }
  if (!response.ok) throw await responseError(response, 'Unable to check room. Please try again.')
  const data = await response.json()
  if (typeof data?.exists !== 'boolean') throw new RoomAccessError('Invalid room response')
  return { exists: data.exists, passwordRequired: data.password_required === true }
}
