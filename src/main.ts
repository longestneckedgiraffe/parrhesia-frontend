import './style.css'
import { ChatConnection, createRoom, checkRoom } from './websocket'
import { deriveColorFromPublicKey } from './crypto'
import type { PeerColor } from './crypto'
import { getStoredPeerKey, markAsVerified, generateSafetyNumber, isTofuEnabled, setTofuEnabled } from './tofu'
import { generateQRCode, initializeScanner, scanQRCode, stopScanner } from './qr'

const DEV_MODE = import.meta.env.DEV

const PARRHESIA_ASCII = `
                                                                                              
                                                                                              
                                         ,---,                                                
,-.----.                               ,--.' |                            ,--,                
\\    /  \\              __  ,-.  __  ,-.|  |  :                          ,--.'|                
|   :    |           ,' ,'/ /|,' ,'/ /|:  :  :                .--.--.   |  |,                 
|   | .\\ :  ,--.--.  '  | |' |'  | |' |:  |  |,--.   ,---.   /  /    '  \`--'_      ,--.--.    
.   : |: | /       \\ |  |   ,'|  |   ,'|  :  '   |  /     \\ |  :  /\`./  ,' ,'|    /       \\   
|   |  \\ :.--.  .-. |'  :  /  '  :  /  |  |   /' : /    /  ||  :  ;_    '  | |   .--.  .-. |  
|   : .  | \\__\\/: . .|  | '   |  | '   '  :  | | |.    ' / | \\  \\    \`. |  | :    \\__\\/: . .  
:     |\`-' ," .--.; |;  : |   ;  : |   |  |  ' | :'   ;   /|  \`----.   \\'  : |__  ," .--.; |  
:   : :   /  /  ,.  ||  , ;   |  , ;   |  :  :_:,''   |  / | /  /\`--'  /|  | '.'|/  /  ,.  |  
|   | :  ;  :   .'   \\---'     ---'    |  | ,'    |   :    |'--'.     / ;  :    ;  :   .'   \\ 
\`---'.|  |  ,     .-./                 \`--''       \\   \\  /   \`--'---'  |  ,   /|  ,     .-./ 
  \`---\`   \`--\`---'                                  \`----'               ---\`-'  \`--\`---'`

type View = 'landing' | 'chat'

interface Message {
  peerId: string
  color: PeerColor
  text: string
  isMine: boolean
  isSystem?: boolean
  isNotification?: boolean
}

let currentRoomId = ''

function getStorageKey(roomId: string): string {
  return `parrhesia-messages-${roomId}`
}

function saveMessages(): void {
  if (!currentRoomId) return
  localStorage.setItem(getStorageKey(currentRoomId), JSON.stringify(messages))
}

function loadMessages(roomId: string): Message[] {
  const stored = localStorage.getItem(getStorageKey(roomId))
  if (!stored) return []
  try {
    return JSON.parse(stored)
  } catch {
    return []
  }
}

function addSystemMessage(text: string): void {
  messages.push({ peerId: 'system', color: 'blue', text, isMine: false, isSystem: true })
  saveMessages()
  render()
}

function addNotification(color: PeerColor, text: string): void {
  messages.push({ peerId: 'notification', color, text, isMine: false, isNotification: true })
  saveMessages()
  render()
}

let currentView: View = 'landing'
let connection: ChatConnection | null = null
let messages: Message[] = []
let canSend = false
let status = ''
let myPeerId = ''
let myColor: PeerColor = 'blue'
let infoCollapsed = false

let showVerificationPanel = false
let selectedPeerForVerification: string | null = null
let verificationSafetyNumber = ''
let qrCodeDataUrl = ''
let isScanning = false
let pendingKeyChangePeers: Map<string, { color: PeerColor; oldKey: string | null; newKey: string }> = new Map()

function render(): void {
  const app = document.querySelector<HTMLDivElement>('#app')!
  const existingInput = document.getElementById('message-input') as HTMLInputElement | null
  const savedValue = existingInput?.value || ''

  if (currentView === 'landing') {
    renderLanding(app)
  } else {
    renderChat(app)
    const newInput = document.getElementById('message-input') as HTMLInputElement
    if (newInput) {
      if (savedValue) newInput.value = savedValue
      newInput.focus()
    }
  }
}

function renderLanding(app: HTMLDivElement): void {
  const tofuEnabled = isTofuEnabled()

  app.innerHTML = `
    <div class="landing">
      <pre class="crow">${PARRHESIA_ASCII}</pre>
      <p><i>end-to-end encrypted chat</i></p>
      <hr>
      <div class="actions">
        <input type="text" id="room-input" placeholder="room id">
        <button id="join-room">Join</button>
        <span class="or">or</span>
        <button id="create-room">Create Room</button>
      </div>
      ${status ? `<p><b>Status:</b> ${status}</p>` : ''}
      <label class="option-row">
        <input type="checkbox" id="tofu-toggle" ${tofuEnabled ? 'checked' : ''}>
        <span>Enable key verification (TOFU)</span>
      </label>
      <div class="footer-links">
        <a href="https://github.com/longestneckedgiraffe/parrhesia-frontend">frontend code</a>
        <a href="https://github.com/longestneckedgiraffe/parrhesia-backend">backend code</a>
      </div>
    </div>
  `
  document.getElementById('create-room')?.addEventListener('click', handleCreateRoom)
  document.getElementById('join-room')?.addEventListener('click', handleJoinRoom)
  document.getElementById('room-input')?.addEventListener('keypress', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') handleJoinRoom()
  })
  document.getElementById('tofu-toggle')?.addEventListener('change', (e) => {
    setTofuEnabled((e.target as HTMLInputElement).checked)
  })
}

function renderPeersList(): string {
  if (!connection) return ''

  const peerIds = connection.getPeerIds()
  if (peerIds.length === 0) return ''

  const tofuEnabled = isTofuEnabled()

  const peersHtml = peerIds.map(peerId => {
    const publicKey = connection!.getPeerPublicKey(peerId)
    if (!publicKey) return ''

    const color = deriveColorFromPublicKey(publicKey)

    if (tofuEnabled) {
      const stored = getStoredPeerKey(currentRoomId, peerId)
      const statusText = stored?.status === 'verified' ? '' : ' (unverified)'
      return `<span class="peer-item color-${color}" data-peer-id="${peerId}">${color}${statusText}</span>`
    }

    return `<span class="color-${color}">${color}</span>`
  }).filter(Boolean).join(' · ')

  if (!peersHtml) return ''
  return `<p class="peers-list">${peersHtml}</p>`
}

function renderKeyChangeWarnings(): string {
  if (pendingKeyChangePeers.size === 0) return ''

  const warnings = Array.from(pendingKeyChangePeers.entries()).map(([peerId, data]) => {
    return `<div class="key-change-warning">
      <span class="color-${data.color}">${data.color}</span>'s key has changed.
      <span class="warning-action" data-action="accept" data-peer-id="${peerId}">[accept]</span>
      <span class="warning-action" data-action="block" data-peer-id="${peerId}">[block]</span>
    </div>`
  }).join('')

  return warnings
}

function renderVerificationPanel(): string {
  if (!showVerificationPanel || !selectedPeerForVerification) return ''

  const peerKey = connection?.getPeerPublicKey(selectedPeerForVerification)
  if (!peerKey) return ''

  const color = deriveColorFromPublicKey(peerKey)
  const stored = getStoredPeerKey(currentRoomId, selectedPeerForVerification)
  const isVerified = stored?.status === 'verified'

  return `
    <div class="verification-overlay" id="verification-overlay">
      <div class="verification-panel">
        <div class="verification-header">
          <span>Verify <span class="color-${color}">${color}</span></span>
          <span id="close-verification" class="close-link">[close]</span>
        </div>
        <hr>
        <div class="verification-content">
          <p>Safety Number:</p>
          <div class="safety-number">${verificationSafetyNumber}</div>
          <p class="safety-hint">Compare this number with your contact.</p>
          <div class="verification-actions">
            <span id="show-qr-btn" class="action-link">[show qr]</span>
            <span id="scan-qr-btn" class="action-link">[scan qr]</span>
            ${!isVerified ? '<span id="mark-verified-btn" class="action-link">[mark verified]</span>' : '<span class="verified-text">(verified)</span>'}
          </div>
          ${qrCodeDataUrl ? `<div class="qr-display"><img src="${qrCodeDataUrl}" alt="QR Code"></div>` : ''}
          ${isScanning ? `
            <div class="qr-scanner">
              <video id="scanner-video" autoplay playsinline></video>
              <span id="stop-scan-btn" class="action-link">[stop scanning]</span>
            </div>
          ` : ''}
        </div>
      </div>
    </div>
  `
}

function renderChat(app: HTMLDivElement): void {
  const peersList = renderPeersList()
  const keyChangeWarnings = renderKeyChangeWarnings()
  const verificationPanel = renderVerificationPanel()

  const messagesHtml = messages
    .map(m => {
      if (m.isSystem) {
        return `<div class="message system"><span class="text">${m.text}</span></div>`
      }
      if (m.isNotification) {
        const colorClass = `color-${m.color}`
        return `<div class="message notification ${colorClass}"><span class="peer">${m.color}</span><span class="text">${m.text}</span></div>`
      }
      const colorClass = `color-${m.color}`
      const peerName = m.isMine ? myColor : m.color
      return `<div class="message ${colorClass}"><span class="peer">${peerName}</span><span class="text">${m.text}</span></div>`
    })
    .join('')

  app.innerHTML = `
    <div class="chat">
      ${keyChangeWarnings}
      <div class="chat-info${infoCollapsed ? ' collapsed' : ''}" id="chat-info">
        <div class="chat-info-full">
          <p>Parrhesia is a free, basic, end-to-end encrypted messaging service. Messages are encrypted on your device before being sent to the server, and can only be decrypted by participants in the room. The server never has access to your message content.</p>
          <p>To leave or rejoin, simply close or reopen this page. To invite others, share the link or <span id="copy-room-id" class="copy-link">copy the room ID</span>. Rooms automatically close after 24 hours of inactivity.</p>
          ${peersList}
          <p>Thank you for using Parrhesia <3</p>
        </div>
        <div class="chat-info-collapsed">Peers connected: ${connection?.getPeerCount() || 0}</div>
      </div>
      <div class="messages" id="messages">${messagesHtml || '<p class="empty">No messages yet</p>'}</div>
      <div class="chat-input">
        <input type="text" id="message-input" placeholder="Type a message..." ${canSend ? '' : 'disabled'}>
        <button id="send-message" ${canSend ? '' : 'disabled'}>Send</button>
      </div>
    </div>
    ${verificationPanel}
  `
  document.getElementById('chat-info')?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).id === 'copy-room-id') return
    infoCollapsed = !infoCollapsed
    render()
  })
  document.getElementById('copy-room-id')?.addEventListener('click', (e) => {
    e.stopPropagation()
    navigator.clipboard.writeText(currentRoomId)
    const el = document.getElementById('copy-room-id')
    if (el) {
      el.textContent = 'copied'
      setTimeout(() => { el.textContent = 'copy the room ID' }, 500)
    }
  })
  document.getElementById('send-message')?.addEventListener('click', handleSendMessage)
  document.getElementById('message-input')?.addEventListener('keypress', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') handleSendMessage()
  })
  const messagesDiv = document.getElementById('messages')
  if (messagesDiv) messagesDiv.scrollTop = messagesDiv.scrollHeight

  document.querySelectorAll('.peer-item').forEach(el => {
    el.addEventListener('click', async (e) => {
      e.stopPropagation()
      const peerId = (e.currentTarget as HTMLElement).dataset.peerId
      if (peerId) await openVerificationPanel(peerId)
    })
  })

  document.querySelectorAll('.warning-action').forEach(el => {
    el.addEventListener('click', async (e) => {
      const target = e.currentTarget as HTMLElement
      const action = target.dataset.action
      const peerId = target.dataset.peerId
      if (!peerId) return
      if (action === 'accept') await handleAcceptKeyChange(peerId)
      else if (action === 'block') handleRejectKeyChange(peerId)
    })
  })

  document.getElementById('close-verification')?.addEventListener('click', closeVerificationPanel)
  document.getElementById('show-qr-btn')?.addEventListener('click', showQRCode)
  document.getElementById('scan-qr-btn')?.addEventListener('click', startQRScan)
  document.getElementById('stop-scan-btn')?.addEventListener('click', stopQRScan)
  document.getElementById('mark-verified-btn')?.addEventListener('click', handleMarkVerified)
  document.getElementById('verification-overlay')?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).id === 'verification-overlay') closeVerificationPanel()
  })
}

async function openVerificationPanel(peerId: string): Promise<void> {
  selectedPeerForVerification = peerId
  showVerificationPanel = true
  qrCodeDataUrl = ''
  isScanning = false

  const myPublicKey = connection?.getMyPublicKey()
  const peerPublicKey = connection?.getPeerPublicKey(peerId)

  if (myPublicKey && peerPublicKey) {
    verificationSafetyNumber = await generateSafetyNumber(myPublicKey, peerPublicKey)
  }

  render()
}

function closeVerificationPanel(): void {
  showVerificationPanel = false
  selectedPeerForVerification = null
  verificationSafetyNumber = ''
  qrCodeDataUrl = ''
  if (isScanning) {
    const video = document.getElementById('scanner-video') as HTMLVideoElement
    if (video) stopScanner(video)
  }
  isScanning = false
  render()
}

async function showQRCode(): Promise<void> {
  if (!connection) return
  const myPublicKey = connection.getMyPublicKey()
  qrCodeDataUrl = await generateQRCode(myPublicKey)
  render()
}

async function startQRScan(): Promise<void> {
  isScanning = true
  qrCodeDataUrl = ''
  render()

  await new Promise(resolve => setTimeout(resolve, 100))

  const video = document.getElementById('scanner-video') as HTMLVideoElement
  if (video) {
    try {
      await initializeScanner(video)
      pollForQRCode(video)
    } catch {
      addSystemMessage('Unable to access camera')
      isScanning = false
      render()
    }
  }
}

function pollForQRCode(video: HTMLVideoElement): void {
  if (!isScanning) return

  const result = scanQRCode(video)
  if (result && selectedPeerForVerification) {
    const peerPublicKey = connection?.getPeerPublicKey(selectedPeerForVerification)
    if (peerPublicKey && result === peerPublicKey) {
      markAsVerified(currentRoomId, selectedPeerForVerification)
      addSystemMessage('Key verified successfully')
      stopQRScan()
    } else if (result) {
      addSystemMessage('Scanned key does not match')
      stopQRScan()
    } else {
      requestAnimationFrame(() => pollForQRCode(video))
    }
  } else {
    requestAnimationFrame(() => pollForQRCode(video))
  }
}

function stopQRScan(): void {
  const video = document.getElementById('scanner-video') as HTMLVideoElement
  if (video) stopScanner(video)
  isScanning = false
  render()
}

function handleMarkVerified(): void {
  if (selectedPeerForVerification) {
    markAsVerified(currentRoomId, selectedPeerForVerification)
    addSystemMessage('Peer marked as verified')
    render()
  }
}

async function handleAcceptKeyChange(peerId: string): Promise<void> {
  pendingKeyChangePeers.delete(peerId)
  await connection?.acceptPeerKeyChange(peerId)
  render()
}

function handleRejectKeyChange(peerId: string): void {
  pendingKeyChangePeers.delete(peerId)
  connection?.rejectPeerKeyChange(peerId)
  addSystemMessage('Blocked peer due to key change')
  render()
}

function handleKeyChange(peerId: string, color: PeerColor, oldKey: string | null, newKey: string): void {
  pendingKeyChangePeers.set(peerId, { color, oldKey, newKey })
  addSystemMessage(`${color}'s encryption key has changed`)
}

async function handleCreateRoom(): Promise<void> {
  if (DEV_MODE) {
    const fakeRoomId = 'dev-' + Math.random().toString(36).slice(2, 10)
    await joinRoom(fakeRoomId)
    return
  }
  try {
    const roomId = await createRoom()
    await joinRoom(roomId)
  } catch {
    status = 'Unable to create room'
    render()
  }
}

async function handleJoinRoom(): Promise<void> {
  const input = document.getElementById('room-input') as HTMLInputElement
  const roomId = input.value.trim()
  if (!roomId) {
    status = 'Please enter a room ID'
    render()
    return
  }
  if (DEV_MODE) {
    await joinRoom(roomId)
    return
  }
  const exists = await checkRoom(roomId)
  if (!exists) {
    status = 'Room does not exist'
    render()
    return
  }
  await joinRoom(roomId)
}

async function joinRoom(roomId: string): Promise<void> {
  currentRoomId = roomId
  messages = loadMessages(roomId)
  canSend = false

  if (DEV_MODE) {
    myPeerId = 'dev-user'
    myColor = deriveColorFromPublicKey('dev-public-key')
    canSend = true
    currentView = 'chat'
    const url = new URL(window.location.href)
    url.searchParams.set('room', roomId)
    window.history.pushState({}, '', url.toString())
    render()
    if (messages.length === 0) {
      addSystemMessage('Running in development mode')
    }
    return
  }

  connection = new ChatConnection(
    roomId,
    (peerId, color, text) => {
      messages.push({ peerId, color, text, isMine: false })
      saveMessages()
      render()
    },
    (_peerId, color) => {
      canSend = connection?.canSend() || false
      infoCollapsed = true
      addNotification(color, 'has joined')
    },
    (_peerId, color) => {
      canSend = connection?.canSend() || false
      addNotification(color, 'has left')
    },
    (newStatus) => {
      canSend = connection?.canSend() || false
      addSystemMessage(newStatus)
    },
    handleKeyChange
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

async function handleSendMessage(): Promise<void> {
  const input = document.getElementById('message-input') as HTMLInputElement
  const text = input.value.trim()
  if (!text || !canSend) return

  messages.push({ peerId: myPeerId, color: myColor, text, isMine: true })
  saveMessages()
  input.value = ''
  render()

  const newInput = document.getElementById('message-input') as HTMLInputElement
  newInput?.focus()

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
      status = 'Room does not exist or has expired'
    }
  }

  render()
}

init()
