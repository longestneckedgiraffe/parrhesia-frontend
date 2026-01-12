const API_BASE = import.meta.env.VITE_API_URL || 'https://api.parrhesia.chat'

export const config = {
  apiBase: API_BASE,
  wsBase: API_BASE.replace(/^http/, 'ws'),
  endpoints: {
    createRoom: `${API_BASE}/api/rooms`,
    checkRoom: (id: string) => `${API_BASE}/api/rooms/${id}`,
    websocket: (roomId: string) => `${API_BASE.replace(/^http/, 'ws')}/ws/${roomId}`
  }
}
