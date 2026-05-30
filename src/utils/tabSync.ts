const CHANNEL_NAME = 'parrhesia-tab-sync'
const STORAGE_KEY = 'parrhesia-active-rooms'
const HEARTBEAT_INTERVAL = 2000
const STALE_THRESHOLD = 5000

type MessageType = 'room_claim' | 'room_release' | 'room_query' | 'room_response'

interface TabMessage {
  type: MessageType
  roomId: string
  tabId: string
  timestamp: number
}

interface ActiveRoom {
  tabId: string
  timestamp: number
}

const tabId = crypto.randomUUID()
let channel: BroadcastChannel | null = null
let activeRoom: string | null = null
let heartbeatInterval: number | null = null

function getActiveRooms(): Record<string, ActiveRoom> {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored ? JSON.parse(stored) : {}
  } catch {
    return {}
  }
}

function setActiveRooms(rooms: Record<string, ActiveRoom>): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(rooms))
}

function cleanStaleRooms(): void {
  const rooms = getActiveRooms()
  const now = Date.now()
  let changed = false

  for (const roomId of Object.keys(rooms)) {
    if (now - rooms[roomId].timestamp > STALE_THRESHOLD) {
      delete rooms[roomId]
      changed = true
    }
  }

  if (changed) {
    setActiveRooms(rooms)
  }
}

function claimRoom(roomId: string): void {
  const rooms = getActiveRooms()
  rooms[roomId] = { tabId, timestamp: Date.now() }
  setActiveRooms(rooms)
  activeRoom = roomId

  if (channel) {
    const message: TabMessage = { type: 'room_claim', roomId, tabId, timestamp: Date.now() }
    channel.postMessage(message)
  }

  if (heartbeatInterval) {
    clearInterval(heartbeatInterval)
  }
  heartbeatInterval = window.setInterval(() => {
    if (activeRoom) {
      const rooms = getActiveRooms()
      if (rooms[activeRoom]?.tabId === tabId) {
        rooms[activeRoom].timestamp = Date.now()
        setActiveRooms(rooms)
      }
    }
  }, HEARTBEAT_INTERVAL)
}

function releaseRoom(roomId: string): void {
  const rooms = getActiveRooms()
  if (rooms[roomId]?.tabId === tabId) {
    delete rooms[roomId]
    setActiveRooms(rooms)
  }

  if (channel) {
    const message: TabMessage = { type: 'room_release', roomId, tabId, timestamp: Date.now() }
    channel.postMessage(message)
  }

  if (activeRoom === roomId) {
    activeRoom = null
  }

  if (heartbeatInterval) {
    clearInterval(heartbeatInterval)
    heartbeatInterval = null
  }
}

export function isRoomOccupied(roomId: string): boolean {
  cleanStaleRooms()
  const rooms = getActiveRooms()
  const room = rooms[roomId]
  if (!room) return false
  if (room.tabId === tabId) return false
  return Date.now() - room.timestamp < STALE_THRESHOLD
}

export function onRoomJoined(roomId: string): void {
  claimRoom(roomId)
}

export function onRoomLeft(roomId: string): void {
  releaseRoom(roomId)
}

export function initTabSync(): void {
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(CHANNEL_NAME)
  }

  cleanStaleRooms()

  window.addEventListener('beforeunload', () => {
    if (activeRoom) {
      releaseRoom(activeRoom)
    }
  })

  window.addEventListener('pagehide', () => {
    if (activeRoom) {
      releaseRoom(activeRoom)
    }
  })
}
