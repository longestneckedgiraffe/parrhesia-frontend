import './style.css'
import { ChatConnection, createRoom, checkRoom } from './websocket'

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
  text: string
  isMine: boolean
}

let currentView: View = 'landing'
let connection: ChatConnection | null = null
let messages: Message[] = []
let canSend = false
let status = ''
let myPeerId = ''

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
    .map(m => `<div class="message ${m.isMine ? 'mine' : 'theirs'}"><span class="peer">${m.isMine ? 'you' : m.peerId.slice(0, 8)}</span><span class="text">${m.text}</span></div>`)
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

  connection = new ChatConnection(
    roomId,
    (peerId, text) => {
      messages.push({ peerId, text, isMine: false })
      render()
    },
    () => {
      canSend = connection?.canSend() || false
      render()
    },
    () => {
      canSend = connection?.canSend() || false
      render()
    },
    (newStatus) => {
      status = newStatus
      canSend = connection?.canSend() || false
      render()
    }
  )

  currentView = 'chat'
  render()

  await connection.connect()
  myPeerId = connection.getPeerId()

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
  if (!text || !connection || !canSend) return

  messages.push({ peerId: myPeerId, text, isMine: true })
  input.value = ''
  render()

  await connection.sendMessage(text)
}

async function init(): Promise<void> {
  const url = new URL(window.location.href)
  const roomId = url.searchParams.get('room')

  if (roomId) {
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
