const API_BASE = 'https://api.parrhesia.chat'

export const config = {
  apiBase: API_BASE,
  wsBase: API_BASE.replace(/^http/, 'ws'),
  endpoints: {
    createRoom: `${API_BASE}/api/rooms`,
    checkRoom: (id: string) => `${API_BASE}/api/rooms/${encodeURIComponent(id)}`,
    websocket: (roomId: string) => `${API_BASE.replace(/^http/, 'ws')}/ws/${encodeURIComponent(roomId)}`
  }
}
