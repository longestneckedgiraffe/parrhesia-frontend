import './style.css'
import { ChatConnection, createRoom, checkRoom } from './websocket'
import type { PeerColor } from './crypto'
import { isKeyPasswordProtected, hasStoredKeys, deriveMessageKey, encryptMessages, decryptMessages, isEncryptedData } from './crypto'
import { getStoredPeerKey, markAsVerified, generateSafetyNumber } from './tofu'
import { generateQRCode, initializeScanner, scanQRCode, stopScanner } from './qr'

function getTheme(): 'light' | 'dark' | null {
  return localStorage.getItem('parrhesia-theme') as 'light' | 'dark' | null
}

function setTheme(theme: 'light' | 'dark' | null): void {
  if (theme) {
    localStorage.setItem('parrhesia-theme', theme)
    document.documentElement.setAttribute('data-theme', theme)
  } else {
    localStorage.removeItem('parrhesia-theme')
    document.documentElement.removeAttribute('data-theme')
  }
}

function getCurrentEffectiveTheme(): 'light' | 'dark' {
  return getTheme() || 'light'
}

function toggleTheme(): void {
  const current = getCurrentEffectiveTheme()
  setTheme(current === 'light' ? 'dark' : 'light')
}

function initTheme(): void {
  const stored = getTheme()
  if (stored) {
    document.documentElement.setAttribute('data-theme', stored)
  }
}

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
  verified?: boolean
}

let currentRoomId = ''
let messageEncryptionKey: CryptoKey | null = null

function getStorageKey(roomId: string): string {
  return `parrhesia-messages-${roomId}`
}

async function saveMessages(): Promise<void> {
  if (!currentRoomId) return
  if (messageEncryptionKey) {
    const encrypted = await encryptMessages(messages, messageEncryptionKey)
    localStorage.setItem(getStorageKey(currentRoomId), JSON.stringify(encrypted))
  } else {
    localStorage.setItem(getStorageKey(currentRoomId), JSON.stringify(messages))
  }
}

async function loadMessages(roomId: string): Promise<Message[]> {
  const stored = localStorage.getItem(getStorageKey(roomId))
  if (!stored) return []
  try {
    const parsed = JSON.parse(stored)
    if (isEncryptedData(parsed) && messageEncryptionKey) {
      return await decryptMessages(parsed, messageEncryptionKey) as Message[]
    }
    if (isEncryptedData(parsed) && !messageEncryptionKey) {
      return []
    }
    return parsed
  } catch {
    return []
  }
}

async function addSystemMessage(text: string): Promise<void> {
  messages.push({ peerId: 'system', color: 'blue', text, isMine: false, isSystem: true })
  await saveMessages()
  render()
}

async function addNotification(color: PeerColor, text: string, verified?: boolean): Promise<void> {
  messages.push({ peerId: 'notification', color, text, isMine: false, isNotification: true, verified })
  await saveMessages()
  render()
}

let currentView: View = 'landing'
let connection: ChatConnection | null = null
let messages: Message[] = []
let canSend = false
let status = ''
let myPeerId = ''
let myColor: PeerColor = 'blue'

let showVerificationPanel = false
let selectedPeerForVerification: string | null = null
let verificationSafetyNumber = ''
let qrCodeDataUrl = ''
let isScanning = false

let showPasswordModal = false
let passwordModalMode: 'setup' | 'unlock' = 'setup'
let passwordError = ''
let pendingRoomId: string | null = null

function renderPasswordModal(): string {
  if (!showPasswordModal) return ''

  const isSetup = passwordModalMode === 'setup'
  const description = isSetup
    ? 'Add a password to encrypt your private keys and messages (highly recommended). This is a one-time choice; skipping requires clearing browser data to enable later.'
    : 'Enter your password to unlock your encrypted keys.'

  return `
    <div class="verification-overlay" id="password-overlay">
      <div class="verification-panel">
        <div class="verification-header">
          <span id="close-password-modal" class="close-link">${isSetup ? 'Skip' : 'Cancel'}</span>
        </div>
        <div class="verification-info">${description}</div>
        <input type="password" id="password-input" class="password-input" placeholder="Enter password" autofocus>
        ${isSetup ? '<input type="password" id="password-confirm" class="password-input" placeholder="Confirm password">' : ''}
        ${passwordError ? `<div class="password-error">${passwordError}</div>` : ''}
        <div class="verification-actions">
          <span id="password-submit" class="action-link">${isSetup ? 'Set Password' : 'Unlock'}</span>
        </div>
      </div>
    </div>
  `
}

function setupPasswordModalListeners(): void {
  document.getElementById('close-password-modal')?.addEventListener('click', handlePasswordModalClose)
  document.getElementById('password-submit')?.addEventListener('click', handlePasswordSubmit)
  document.getElementById('password-input')?.addEventListener('keypress', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') {
      if (passwordModalMode === 'setup') {
        document.getElementById('password-confirm')?.focus()
      } else {
        handlePasswordSubmit()
      }
    }
  })
  document.getElementById('password-confirm')?.addEventListener('keypress', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') handlePasswordSubmit()
  })
}

async function handlePasswordModalClose(): Promise<void> {
  if (passwordModalMode === 'setup' && pendingRoomId) {
    showPasswordModal = false
    passwordError = ''
    await joinRoom(pendingRoomId, undefined)
    pendingRoomId = null
  } else {
    showPasswordModal = false
    passwordError = ''
    pendingRoomId = null
    render()
  }
}

async function handlePasswordSubmit(): Promise<void> {
  const passwordInput = document.getElementById('password-input') as HTMLInputElement
  const password = passwordInput.value

  if (!password) {
    passwordError = 'Password is required'
    render()
    return
  }

  if (passwordModalMode === 'setup') {
    const confirmInput = document.getElementById('password-confirm') as HTMLInputElement
    const confirm = confirmInput.value

    if (password !== confirm) {
      passwordError = 'Passwords do not match'
      render()
      return
    }

    if (password.length < 8) {
      passwordError = 'Password must be at least 8 characters'
      render()
      return
    }
  }

  showPasswordModal = false
  passwordError = ''

  messageEncryptionKey = await deriveMessageKey(password)

  if (pendingRoomId) {
    try {
      await joinRoom(pendingRoomId, password)
    } catch (e) {
      if (passwordModalMode === 'unlock') {
        messageEncryptionKey = null
        passwordError = 'Invalid password'
        showPasswordModal = true
        render()
        return
      }
      status = 'Failed to join room'
      render()
    }
    pendingRoomId = null
  }
}

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

  const passwordModal = renderPasswordModal()
  if (passwordModal) {
    app.insertAdjacentHTML('beforeend', passwordModal)
    setupPasswordModalListeners()
  }
}

function renderLanding(app: HTMLDivElement): void {
  const theme = getCurrentEffectiveTheme()

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
      <div class="footer-links">
        <a href="https://github.com/longestneckedgiraffe/parrhesia-frontend">frontend code</a>
        <a href="https://github.com/longestneckedgiraffe/parrhesia-backend">backend code</a>
      </div>
      <div class="theme-toggle">
        <a id="theme-toggle">${theme}</a>
      </div>
    </div>
  `
  document.getElementById('create-room')?.addEventListener('click', handleCreateRoom)
  document.getElementById('join-room')?.addEventListener('click', handleJoinRoom)
  document.getElementById('room-input')?.addEventListener('keypress', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') handleJoinRoom()
  })
  document.getElementById('theme-toggle')?.addEventListener('click', () => {
    toggleTheme()
    render()
  })
}

function renderPeersList(): string {
  if (!connection) return ''

  const peerIds = connection.getPeerIds()
  const peers: string[] = []

  const myPublicKey = connection.getMyPublicKey()
  if (myPublicKey) {
    peers.push(`<span class="color-${myColor}">${myColor} (you)</span>`)
  }

  peerIds.forEach(peerId => {
    const color = connection!.getPeerColor(peerId)
    const publicKey = connection!.getPeerPublicKey(peerId)
    const stored = publicKey ? getStoredPeerKey(currentRoomId, peerId, publicKey) : null
    const isVerified = stored?.status === 'verified'
    const colorClass = isVerified ? `color-${color}` : 'color-unverified'
    const displayName = isVerified ? color : 'unverified'
    peers.push(`<span class="peer-item ${colorClass}" data-peer-id="${peerId}">${displayName}</span>`)
  })

  if (peers.length === 0) return ''
  return `<div class="peers-list">${peers.join(' ')}</div>`
}


function renderVerificationPanel(): string {
  if (!showVerificationPanel || !selectedPeerForVerification) return ''

  const peerKey = connection?.getPeerPublicKey(selectedPeerForVerification)
  if (!peerKey) return ''

  const stored = getStoredPeerKey(currentRoomId, selectedPeerForVerification, peerKey)
  const isVerified = stored?.status === 'verified'

  return `
    <div class="verification-overlay" id="verification-overlay">
      <div class="verification-panel">
        <div class="verification-header">
          <span id="close-verification" class="close-link">Close</span>
        </div>
        <div class="verification-info">Compare this number with your contact to verify the connection is secure.</div>
        <div class="safety-number">${verificationSafetyNumber}</div>
        <div class="verification-actions">
          <span id="show-qr-btn" class="action-link">${qrCodeDataUrl ? 'Hide QR' : 'Show QR'}</span>
          <span id="scan-qr-btn" class="action-link">Scan QR</span>
          ${!isVerified ? '<span id="mark-verified-btn" class="action-link">Verify</span>' : '<span class="verified-text">Verified</span>'}
        </div>
        ${qrCodeDataUrl ? `<div class="qr-display"><img src="${qrCodeDataUrl}" alt="QR Code"></div>` : ''}
        ${isScanning ? `
          <div class="qr-scanner">
            <video id="scanner-video" autoplay playsinline></video>
            <span id="stop-scan-btn" class="action-link">Stop</span>
          </div>
        ` : ''}
      </div>
    </div>
  `
}

function renderChat(app: HTMLDivElement): void {
  const peersList = renderPeersList()
  const verificationPanel = renderVerificationPanel()
  const theme = getCurrentEffectiveTheme()

  const messagesHtml = messages
    .map(m => {
      if (m.isSystem) {
        return `<div class="message system"><span class="text">${m.text}</span></div>`
      }
      if (m.isNotification) {
        const isVerified = m.verified ?? false
        const colorClass = isVerified ? `color-${m.color}` : 'color-unverified'
        const peerLabel = isVerified ? m.color : 'unverified'
        return `<div class="message notification ${colorClass}"><span class="peer">${peerLabel}</span><span class="text">${m.text}</span></div>`
      }
      const isVerified = m.isMine || (m.verified ?? false)
      const colorClass = isVerified ? `color-${m.color}` : 'color-unverified'
      const peerName = m.isMine ? myColor : (isVerified ? m.color : 'unverified')
      return `<div class="message ${colorClass}"><span class="peer">${peerName}</span><span class="text">${m.text}</span></div>`
    })
    .join('')

  const peerCount = connection?.getPeerCount() || 0
  const statusText = peerCount === 0 ? 'Waiting for peers.' : ''

  app.innerHTML = `
    <div class="chat">
      <div class="chat-header">
        ${peersList || `<span class="status-text">${statusText}</span>`}
      </div>
      <div class="messages" id="messages">${messagesHtml}</div>
      <div class="chat-input">
        <input type="text" id="message-input" placeholder="Type a message..." ${canSend ? '' : 'disabled'}>
        <button id="send-message" ${canSend ? '' : 'disabled'}>Send</button>
      </div>
    </div>
    <div class="theme-toggle">
      <a id="theme-toggle">${theme}</a>
    </div>
    ${verificationPanel}
  `
  document.getElementById('send-message')?.addEventListener('click', handleSendMessage)
  document.getElementById('message-input')?.addEventListener('keypress', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') handleSendMessage()
  })
  document.getElementById('theme-toggle')?.addEventListener('click', () => {
    toggleTheme()
    render()
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

  document.getElementById('close-verification')?.addEventListener('click', closeVerificationPanel)
  document.getElementById('show-qr-btn')?.addEventListener('click', toggleQRCode)
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

async function toggleQRCode(): Promise<void> {
  if (qrCodeDataUrl) {
    qrCodeDataUrl = ''
    render()
    return
  }
  const myPublicKey = connection?.getMyPublicKey()
  if (!myPublicKey) return
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
      markAsVerified(currentRoomId, selectedPeerForVerification, peerPublicKey)
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
    const peerPublicKey = connection?.getPeerPublicKey(selectedPeerForVerification)
    if (peerPublicKey) {
      markAsVerified(currentRoomId, selectedPeerForVerification, peerPublicKey)
      addSystemMessage('Peer marked as verified')
    }
    render()
  }
}

function handleKeyChange(_peerId: string, color: PeerColor): void {
  addSystemMessage(`${color} was blocked due to key change`)
}

async function handleCreateRoom(): Promise<void> {
  try {
    const roomId = await createRoom()

    if (isKeyPasswordProtected()) {
      pendingRoomId = roomId
      passwordModalMode = 'unlock'
      showPasswordModal = true
      render()
    } else if (!hasStoredKeys()) {
      pendingRoomId = roomId
      passwordModalMode = 'setup'
      showPasswordModal = true
      render()
    } else {
      await joinRoom(roomId, undefined)
    }
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
  const exists = await checkRoom(roomId)
  if (!exists) {
    status = 'Room does not exist'
    render()
    return
  }

  if (isKeyPasswordProtected()) {
    pendingRoomId = roomId
    passwordModalMode = 'unlock'
    showPasswordModal = true
    render()
  } else if (!hasStoredKeys()) {
    pendingRoomId = roomId
    passwordModalMode = 'setup'
    showPasswordModal = true
    render()
  } else {
    await joinRoom(roomId, undefined)
  }
}

async function joinRoom(roomId: string, password?: string): Promise<void> {
  canSend = false

  const newConnection = new ChatConnection(
    roomId,
    async (peerId, color, text) => {
      const publicKey = connection?.getPeerPublicKey(peerId)
      const stored = publicKey ? getStoredPeerKey(roomId, peerId, publicKey) : null
      const verified = stored?.status === 'verified'
      messages.push({ peerId, color, text, isMine: false, verified })
      await saveMessages()
      render()
    },
    (peerId, color, publicKey) => {
      canSend = connection?.canSend() || false
      const stored = publicKey ? getStoredPeerKey(roomId, peerId, publicKey) : null
      const verified = stored?.status === 'verified'
      addNotification(color, 'has joined', verified)
    },
    (peerId, color, publicKey) => {
      canSend = connection?.canSend() || false
      const stored = publicKey ? getStoredPeerKey(roomId, peerId, publicKey) : null
      const verified = stored?.status === 'verified'
      addNotification(color, 'has left', verified)
    },
    (newStatus) => {
      canSend = connection?.canSend() || false
      addSystemMessage(newStatus)
    },
    handleKeyChange
  )

  await newConnection.connect(password)

  connection = newConnection
  currentRoomId = roomId
  messages = await loadMessages(roomId)
  myPeerId = connection.getPeerId()
  myColor = connection.getMyColor()
  currentView = 'chat'
  render()

  const url = new URL(window.location.href)
  url.searchParams.set('room', roomId)
  window.history.pushState({}, '', url.toString())
}

async function handleSendMessage(): Promise<void> {
  const input = document.getElementById('message-input') as HTMLInputElement
  const text = input.value.trim()
  if (!text || !canSend) return

  messages.push({ peerId: myPeerId, color: myColor, text, isMine: true })
  await saveMessages()
  input.value = ''
  render()

  const newInput = document.getElementById('message-input') as HTMLInputElement
  newInput?.focus()

  if (connection) {
    await connection.sendMessage(text)
  }
}

const SANDBOX_COMPONENTS = [
  'landing',
  'chat-empty',
  'chat-with-messages',
  'chat-with-peers',
  'password-setup',
  'password-unlock',
  'password-error',
  'verification-panel',
  'verification-with-qr',
  'verification-verified'
] as const

type SandboxComponent = typeof SANDBOX_COMPONENTS[number]

let sandboxComponent: SandboxComponent = 'landing'

function isLocalhost(): boolean {
  return window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
}

function renderSandbox(): void {
  const app = document.querySelector<HTMLDivElement>('#app')!
  const theme = getCurrentEffectiveTheme()

  const options = SANDBOX_COMPONENTS.map(c =>
    `<option value="${c}" ${c === sandboxComponent ? 'selected' : ''}>${c}</option>`
  ).join('')

  const componentHtml = renderSandboxComponent(sandboxComponent)

  app.innerHTML = `
    <div class="sandbox">
      <div class="sandbox-controls">
        <select id="sandbox-select">${options}</select>
        <a id="theme-toggle">${theme}</a>
        <a href="/">exit</a>
      </div>
      <div class="sandbox-preview">
        ${componentHtml}
      </div>
    </div>
  `

  document.getElementById('sandbox-select')?.addEventListener('change', (e) => {
    sandboxComponent = (e.target as HTMLSelectElement).value as SandboxComponent
    renderSandbox()
  })

  document.getElementById('theme-toggle')?.addEventListener('click', () => {
    toggleTheme()
    renderSandbox()
  })
}

function renderSandboxComponent(component: SandboxComponent): string {
  switch (component) {
    case 'landing':
      return `
        <div class="landing">
          <pre class="crow">${PARRHESIA_ASCII}</pre>
          <p><i>end-to-end encrypted chat</i></p>
          <hr>
          <div class="actions">
            <input type="text" id="room-input" placeholder="room id">
            <button>Join</button>
            <span class="or">or</span>
            <button>Create Room</button>
          </div>
        </div>
      `

    case 'chat-empty':
      return `
        <div class="chat">
          <div class="chat-header">
            <span class="status-text">Waiting for peers.</span>
          </div>
          <div class="messages"></div>
          <div class="chat-input">
            <input type="text" placeholder="Type a message..." disabled>
            <button disabled>Send</button>
          </div>
        </div>
      `

    case 'chat-with-messages':
      return `
        <div class="chat">
          <div class="chat-header">
            <div class="peers-list">
              <span class="color-blue">blue (you)</span>
              <span class="color-green">green</span>
              <span class="color-unverified">unverified</span>
            </div>
          </div>
          <div class="messages">
            <div class="message system"><span class="text">Waiting for others to join</span></div>
            <div class="message notification color-green"><span class="peer">green</span><span class="text">has joined</span></div>
            <div class="message color-green"><span class="peer">green</span><span class="text">Hello there!</span></div>
            <div class="message color-blue"><span class="peer">blue</span><span class="text">Hey, how are you?</span></div>
            <div class="message notification color-unverified"><span class="peer">unverified</span><span class="text">has joined</span></div>
            <div class="message color-unverified"><span class="peer">unverified</span><span class="text">Hi everyone!</span></div>
          </div>
          <div class="chat-input">
            <input type="text" placeholder="Type a message...">
            <button>Send</button>
          </div>
        </div>
      `

    case 'chat-with-peers':
      return `
        <div class="chat">
          <div class="chat-header">
            <div class="peers-list">
              <span class="color-blue">blue (you)</span>
              <span class="peer-item color-green">green</span>
              <span class="peer-item color-red">red</span>
              <span class="peer-item color-unverified">unverified</span>
            </div>
          </div>
          <div class="messages"></div>
          <div class="chat-input">
            <input type="text" placeholder="Type a message...">
            <button>Send</button>
          </div>
        </div>
      `

    case 'password-setup':
      return `
        <div class="verification-overlay" style="position: relative; height: 400px;">
          <div class="verification-panel">
            <div class="verification-header">
              <span class="close-link">Skip</span>
            </div>
            <div class="verification-info">Add a password to encrypt your private keys and messages (highly recommended). This is a one-time choice; skipping requires clearing browser data to enable later.</div>
            <input type="password" class="password-input" placeholder="Enter password">
            <input type="password" class="password-input" placeholder="Confirm password">
            <div class="verification-actions">
              <span class="action-link">Set Password</span>
            </div>
          </div>
        </div>
      `

    case 'password-unlock':
      return `
        <div class="verification-overlay" style="position: relative; height: 300px;">
          <div class="verification-panel">
            <div class="verification-header">
              <span class="close-link">Cancel</span>
            </div>
            <div class="verification-info">Enter your password to unlock your encrypted keys.</div>
            <input type="password" class="password-input" placeholder="Enter password">
            <div class="verification-actions">
              <span class="action-link">Unlock</span>
            </div>
          </div>
        </div>
      `

    case 'password-error':
      return `
        <div class="verification-overlay" style="position: relative; height: 350px;">
          <div class="verification-panel">
            <div class="verification-header">
              <span class="close-link">Cancel</span>
            </div>
            <div class="verification-info">Enter your password to unlock your encrypted keys.</div>
            <input type="password" class="password-input" placeholder="Enter password">
            <div class="password-error">Invalid password</div>
            <div class="verification-actions">
              <span class="action-link">Unlock</span>
            </div>
          </div>
        </div>
      `

    case 'verification-panel':
      return `
        <div class="verification-overlay" style="position: relative; height: 350px;">
          <div class="verification-panel">
            <div class="verification-header">
              <span class="close-link">Close</span>
            </div>
            <div class="verification-info">Compare this number with your contact to verify the connection is secure.</div>
            <div class="safety-number">12345 67890 11121 31415 16171 81920</div>
            <div class="verification-actions">
              <span class="action-link">Show QR</span>
              <span class="action-link">Scan QR</span>
              <span class="action-link">Verify</span>
            </div>
          </div>
        </div>
      `

    case 'verification-with-qr':
      return `
        <div class="verification-overlay" style="position: relative; height: 450px;">
          <div class="verification-panel">
            <div class="verification-header">
              <span class="close-link">Close</span>
            </div>
            <div class="verification-info">Compare this number with your contact to verify the connection is secure.</div>
            <div class="safety-number">12345 67890 11121 31415 16171 81920</div>
            <div class="verification-actions">
              <span class="action-link">Hide QR</span>
              <span class="action-link">Scan QR</span>
              <span class="action-link">Verify</span>
            </div>
            <div class="qr-display"><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='100'%3E%3Crect fill='%23eee' width='100' height='100'/%3E%3Ctext x='50' y='55' text-anchor='middle' fill='%23999'%3EQR%3C/text%3E%3C/svg%3E" alt="QR Code"></div>
          </div>
        </div>
      `

    case 'verification-verified':
      return `
        <div class="verification-overlay" style="position: relative; height: 350px;">
          <div class="verification-panel">
            <div class="verification-header">
              <span class="close-link">Close</span>
            </div>
            <div class="verification-info">Compare this number with your contact to verify the connection is secure.</div>
            <div class="safety-number">12345 67890 11121 31415 16171 81920</div>
            <div class="verification-actions">
              <span class="action-link">Show QR</span>
              <span class="action-link">Scan QR</span>
              <span class="verified-text">Verified</span>
            </div>
          </div>
        </div>
      `

    default:
      return '<p>Unknown component</p>'
  }
}

async function init(): Promise<void> {
  initTheme()
  const url = new URL(window.location.href)

  if (url.pathname === '/sandbox' && isLocalhost()) {
    renderSandbox()
    return
  }

  const roomId = url.searchParams.get('room')

  if (roomId) {
    const exists = await checkRoom(roomId)
    if (exists) {
      if (isKeyPasswordProtected()) {
        pendingRoomId = roomId
        passwordModalMode = 'unlock'
        showPasswordModal = true
      } else if (!hasStoredKeys()) {
        pendingRoomId = roomId
        passwordModalMode = 'setup'
        showPasswordModal = true
      } else {
        await joinRoom(roomId)
        return
      }
    } else {
      status = 'Room does not exist or has expired'
    }
  }

  render()
}

init()
