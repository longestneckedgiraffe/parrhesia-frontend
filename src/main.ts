import './style.css'
import { ChatConnection, createRoom, checkRoom } from './websocket'
import { getOrAssignMyColor } from './crypto'
import type { PeerColor } from './crypto'

const DEV_MODE = import.meta.env.DEV

const WOLF_ASCII = `                     .
                    / V\\
                  / \`  /
                 <<   |
                 /    |
               /      |
             /        |
           /    \\  \\ /
          (      ) | |
  ________|   _/_  | |
<__________\\______)\\__)`
// credit: https://www.asciiart.eu/animals/wolves

type View = 'landing' | 'chat'

interface Message {
  peerId: string
  color: PeerColor
  text: string
  isMine: boolean
  isSystem?: boolean
}

function addSystemMessage(text: string): void {
  messages.push({ peerId: 'system', color: 'blue', text, isMine: false, isSystem: true })
  render()
}

let currentView: View = 'landing'
let connection: ChatConnection | null = null
let messages: Message[] = []
let canSend = false
let status = ''
let myPeerId = ''
let myColor: PeerColor = 'blue'

function render(): void {
  const app = document.querySelector<HTMLDivElement>('#app')!
  if (currentView === 'landing') {
    renderLanding(app)
  } else {
    renderChat(app)
  }
}

function renderLanding(app: HTMLDivElement): void {
  app.innerHTML = `
    <div class="landing">
      <pre class="wolf">${WOLF_ASCII}</pre>
      <h1>parrhesia</h1>
      <p><i>end-to-end encrypted chat</i></p>
      <hr>
      <div class="actions">
        <button id="create-room">Create Room</button>
        <div class="join-section">
          <input type="text" id="room-input" placeholder="room id" size="30">
          <button id="join-room">Join</button>
        </div>
      </div>
      ${status ? `<p><b>Status:</b> ${status}</p>` : ''}
    </div>
  `
  document.getElementById('create-room')?.addEventListener('click', handleCreateRoom)
  document.getElementById('join-room')?.addEventListener('click', handleJoinRoom)
  document.getElementById('room-input')?.addEventListener('keypress', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') handleJoinRoom()
  })
}

function renderChat(app: HTMLDivElement): void {
  const messagesHtml = messages
    .map(m => {
      const colorClass = m.isSystem ? 'system' : `color-${m.color}`
      const peerName = m.isMine ? myColor : m.isSystem ? 'system' : m.color
      return `<div class="message ${colorClass}"><span class="peer">${peerName}</span><span class="text">${m.text}</span></div>`
    })
    .join('')

  app.innerHTML = `
    <div class="chat">
      <div class="chat-header">
        <button id="leave-room">Leave</button>
        <button id="copy-link">Copy Link</button>
      </div>
      <div class="messages" id="messages">${messagesHtml || '<p class="empty">No messages yet</p>'}</div>
      <div class="chat-input">
        <input type="text" id="message-input" placeholder="Type a message..." ${canSend ? '' : 'disabled'}>
        <button id="send-message" ${canSend ? '' : 'disabled'}>Send</button>
      </div>
    </div>
  `
  document.getElementById('leave-room')?.addEventListener('click', handleLeaveRoom)
  document.getElementById('copy-link')?.addEventListener('click', handleCopyLink)
  document.getElementById('send-message')?.addEventListener('click', handleSendMessage)
  document.getElementById('message-input')?.addEventListener('keypress', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') handleSendMessage()
  })
  const messagesDiv = document.getElementById('messages')
  if (messagesDiv) messagesDiv.scrollTop = messagesDiv.scrollHeight
}

async function handleCreateRoom(): Promise<void> {
  if (DEV_MODE) {
    const fakeRoomId = 'dev-' + Math.random().toString(36).slice(2, 10)
    await joinRoom(fakeRoomId)
    return
  }
  status = 'Creating room...'
  render()
  try {
    const roomId = await createRoom()
    await joinRoom(roomId)
  } catch {
    status = 'Failed to create room'
    render()
  }
}

async function handleJoinRoom(): Promise<void> {
  const input = document.getElementById('room-input') as HTMLInputElement
  const roomId = input.value.trim()
  if (!roomId) {
    status = 'Enter a room ID'
    render()
    return
  }
  if (DEV_MODE) {
    await joinRoom(roomId)
    return
  }
  status = 'Checking room...'
  render()
  const exists = await checkRoom(roomId)
  if (!exists) {
    status = 'Room not found'
    render()
    return
  }
  await joinRoom(roomId)
}

async function joinRoom(roomId: string): Promise<void> {
  messages = []
  canSend = false

  if (DEV_MODE) {
    myPeerId = 'dev-user'
    myColor = getOrAssignMyColor()
    canSend = true
    currentView = 'chat'
    const url = new URL(window.location.href)
    url.searchParams.set('room', roomId)
    window.history.pushState({}, '', url.toString())
    render()
    addSystemMessage('Messages are local only')
    return
  }

  connection = new ChatConnection(
    roomId,
    (peerId, color, text) => {
      messages.push({ peerId, color, text, isMine: false })
      render()
    },
    (_peerId, color) => {
      canSend = connection?.canSend() || false
      addSystemMessage(`${color} joined`)
    },
    (_peerId, color) => {
      canSend = connection?.canSend() || false
      addSystemMessage(`${color} left`)
    },
    (newStatus) => {
      canSend = connection?.canSend() || false
      addSystemMessage(newStatus)
    }
  )

  currentView = 'chat'
  render()

  await connection.connect()
  myPeerId = connection.getPeerId()
  myColor = connection.getMyColor()

  const url = new URL(window.location.href)
  url.searchParams.set('room', roomId)
  window.history.pushState({}, '', url.toString())
}

function handleCopyLink(): void {
  navigator.clipboard.writeText(window.location.href)
  const btn = document.getElementById('copy-link')
  if (btn) {
    btn.textContent = 'Copied!'
    setTimeout(() => { btn.textContent = 'Copy Link' }, 1500)
  }
}

function handleLeaveRoom(): void {
  connection?.disconnect()
  connection = null
  currentView = 'landing'
  status = ''
  messages = []
  canSend = false

  const url = new URL(window.location.href)
  url.searchParams.delete('room')
  window.history.pushState({}, '', url.toString())

  render()
}

async function handleSendMessage(): Promise<void> {
  const input = document.getElementById('message-input') as HTMLInputElement
  const text = input.value.trim()
  if (!text || !canSend) return

  messages.push({ peerId: myPeerId, color: myColor, text, isMine: true })
  input.value = ''
  render()

  if (!DEV_MODE && connection) {
    await connection.sendMessage(text)
  }
}

async function init(): Promise<void> {
  const url = new URL(window.location.href)
  const roomId = url.searchParams.get('room')

  if (roomId) {
    if (DEV_MODE) {
      await joinRoom(roomId)
      return
    }
    const exists = await checkRoom(roomId)
    if (exists) {
      await joinRoom(roomId)
      return
    } else {
      status = 'Room not found or expired'
    }
  }

  render()
}

init()
