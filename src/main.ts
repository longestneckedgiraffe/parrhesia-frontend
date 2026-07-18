import './styles/style.css'
import { ChatConnection, createRoom, checkRoom } from './network/websocket'
import type { PeerColor } from './crypto/crypto'
import { encryptMessages, decryptMessages, isEncryptedData, clearLegacyStorage } from './crypto/crypto'
import { getStoredPeerKey, markAsVerified, generateSafetyNumber } from './crypto/tofu'
import { generateQRCode, initializeScanner, scanQRCode, stopScanner, fingerprintKey } from './utils/qr'
import { initTabSync, isRoomOccupied, onRoomJoined, onRoomLeft } from './utils/tabSync'
import { renderMarkdown } from './utils/markdown'
import termsMarkdown from './content/terms.md?raw'

const TERMS_VERSION = '2026-07-05'
const TERMS_AGREEMENT_STORAGE_KEY = 'parrhesia-terms-agreement'

interface TermsAgreement {
  version: string
  agreedAt: string
}

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

type View = 'landing' | 'chat' | 'terms'

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
  if (!currentRoomId || !messageEncryptionKey) return
  const encrypted = await encryptMessages(messages, messageEncryptionKey)
  localStorage.setItem(getStorageKey(currentRoomId), JSON.stringify(encrypted))
}

async function loadMessages(roomId: string): Promise<Message[]> {
  const stored = localStorage.getItem(getStorageKey(roomId))
  if (!stored) return []
  try {
    const parsed = JSON.parse(stored)
    if (isEncryptedData(parsed)) {
      if (!messageEncryptionKey) return []
      return await decryptMessages(parsed, messageEncryptionKey) as Message[]
    }
    return parsed
  } catch {
    return []
  }
}

function addSystemMessage(text: string): void {
  console.log(`[parrhesia] ${text}`)
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
let landingRoomId = ''

let sessionTermsAgreement = false
let showTermsAgreementModal = false
let termsAgreementPromise: Promise<boolean> | null = null
let termsAgreementResolver: ((agreed: boolean) => void) | null = null

let showVerificationPanel = false
let selectedPeerForVerification: string | null = null
let verificationSafetyNumber = ''
let qrCodeDataUrl = ''
let isScanning = false


const TYPING_THROTTLE_MS = 2000
const TYPING_TIMEOUT_MS = 3000
let typingPeers: Map<string, { color: PeerColor; timeout: ReturnType<typeof setTimeout> }> = new Map()
let lastTypingSent = 0

function render(): void {
  const app = document.querySelector<HTMLDivElement>('#app')!
  const existingInput = document.getElementById('message-input') as HTMLInputElement | null
  const existingRoomInput = document.getElementById('room-input') as HTMLInputElement | null
  const savedValue = existingInput?.value || ''
  if (existingRoomInput) landingRoomId = existingRoomInput.value

  document.body.classList.toggle('terms-page', currentView === 'terms')

  if (currentView === 'landing') {
    renderLanding(app)
  } else if (currentView === 'terms') {
    renderTerms(app)
  } else {
    renderChat(app)
    const newInput = document.getElementById('message-input') as HTMLInputElement
    if (newInput) {
      if (savedValue) newInput.value = savedValue
      newInput.focus()
    }
  }

  if (showTermsAgreementModal && currentView === 'landing') {
    app.insertAdjacentHTML('beforeend', renderTermsAgreementModal())
    bindTermsAgreementModal()
  }
}

function renderLanding(app: HTMLDivElement): void {
  const theme = getCurrentEffectiveTheme()

  app.innerHTML = `
    <div class="landing">
      <pre class="crow">${PARRHESIA_ASCII}</pre>
      <p class="mobile-title"><i>parrhesia</i></p>
      <p class="subtitle"><i>Loquere libere; nihil manet.</i></p>
      <hr>
      <div class="actions">
        <input type="text" id="room-input" placeholder="room id">
        <button id="join-room">Join</button>
        <span class="or">or</span>
        <button id="create-room">Create Room</button>
      </div>
      ${status ? `<p><b>Status:</b> ${status}</p>` : ''}
      <div class="footer-links">
        <div class="footer-row">
          <a id="source-toggle" class="source-toggle">source code</a>
          <a href="?terms" class="terms-link">terms</a>
        </div>
        <div class="source-links">
          <a href="https://github.com/longestneckedgiraffe/parrhesia-frontend">frontend</a>
          <a href="https://github.com/longestneckedgiraffe/parrhesia-backend">backend</a>
        </div>
      </div>
      <div class="theme-toggle">
        <a id="theme-toggle">${theme}</a>
      </div>
    </div>
  `
  const roomInput = document.getElementById('room-input') as HTMLInputElement
  roomInput.value = landingRoomId
  document.getElementById('create-room')?.addEventListener('click', handleCreateRoom)
  document.getElementById('join-room')?.addEventListener('click', handleJoinRoom)
  document.getElementById('room-input')?.addEventListener('keypress', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') handleJoinRoom()
  })
  document.getElementById('source-toggle')?.addEventListener('click', () => {
    document.querySelector('.source-links')?.classList.toggle('visible')
  })
  document.getElementById('theme-toggle')?.addEventListener('click', () => {
    toggleTheme()
    render()
  })
}

function renderTerms(app: HTMLDivElement): void {
  const theme = getCurrentEffectiveTheme()

  app.innerHTML = `
    <div class="terms">
      <a href="/" class="back-link">back</a>
      <div class="terms-content">${renderMarkdown(termsMarkdown)}</div>
    </div>
    <div class="theme-toggle">
      <a id="theme-toggle">${theme}</a>
    </div>
  `
  document.getElementById('theme-toggle')?.addEventListener('click', () => {
    toggleTheme()
    render()
  })
}

function hasTermsAgreement(): boolean {
  if (sessionTermsAgreement) return true

  try {
    const stored = localStorage.getItem(TERMS_AGREEMENT_STORAGE_KEY)
    if (!stored) return false
    const agreement = JSON.parse(stored) as TermsAgreement
    return agreement.version === TERMS_VERSION
  } catch {
    return false
  }
}

function persistTermsAgreement(): void {
  sessionTermsAgreement = true
  const agreement: TermsAgreement = {
    version: TERMS_VERSION,
    agreedAt: new Date().toISOString()
  }

  try {
    localStorage.setItem(TERMS_AGREEMENT_STORAGE_KEY, JSON.stringify(agreement))
  } catch {
    return
  }
}

function renderTermsAgreementModal(): string {
  return `
    <div class="modal-overlay" id="terms-agreement-overlay">
      <div class="modal-panel verification-panel" id="terms-agreement-panel" role="dialog" aria-modal="true" aria-describedby="terms-agreement-description" tabindex="-1">
        <div class="verification-header">
          <button type="button" class="close-link" id="decline-terms">Not now</button>
        </div>
        <div class="verification-info" id="terms-agreement-description">To create or join a room, confirm that you meet the age requirement and agree to the <a href="?terms" target="_blank">terms of service</a>.</div>
        <div class="verification-actions">
          <button type="button" class="action-link" id="accept-terms">I agree</button>
        </div>
      </div>
    </div>
  `
}

function bindTermsAgreementModal(): void {
  const panel = document.getElementById('terms-agreement-panel') as HTMLDivElement | null
  panel?.focus()
  panel?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') resolveTermsAgreement(false)
  })
  document.getElementById('accept-terms')?.addEventListener('click', () => resolveTermsAgreement(true))
  document.getElementById('decline-terms')?.addEventListener('click', () => resolveTermsAgreement(false))
  document.getElementById('terms-agreement-overlay')?.addEventListener('click', (event) => {
    if ((event.target as HTMLElement).id === 'terms-agreement-overlay') resolveTermsAgreement(false)
  })
}

function requestTermsAgreement(): Promise<boolean> {
  if (hasTermsAgreement()) return Promise.resolve(true)
  if (termsAgreementPromise) return termsAgreementPromise

  showTermsAgreementModal = true
  termsAgreementPromise = new Promise(resolve => {
    termsAgreementResolver = resolve
  })
  render()
  return termsAgreementPromise
}

function resolveTermsAgreement(agreed: boolean): void {
  if (agreed) persistTermsAgreement()

  showTermsAgreementModal = false
  const resolve = termsAgreementResolver
  termsAgreementResolver = null
  termsAgreementPromise = null
  render()
  resolve?.(agreed)
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
    <div class="modal-overlay" id="verification-overlay">
      <div class="modal-panel verification-panel">
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


function renderTypingIndicator(): string {
  if (typingPeers.size === 0) return ''
  return Array.from(typingPeers.entries()).map(([peerId, p]) => {
    const publicKey = connection?.getPeerPublicKey(peerId)
    const stored = publicKey ? getStoredPeerKey(currentRoomId, peerId, publicKey) : null
    const isVerified = stored?.status === 'verified'
    const colorClass = isVerified ? `color-${p.color}` : 'color-unverified'
    const peerName = isVerified ? p.color : 'unverified'
    return `<div class="message typing-indicator ${colorClass}"><span class="peer">${peerName}</span><span class="text">is typing</span></div>`
  }).join('')
}

function renderChat(app: HTMLDivElement): void {
  const peersList = renderPeersList()
  const verificationPanel = renderVerificationPanel()
  const theme = getCurrentEffectiveTheme()

  const messagesHtml = messages
    .map(m => {
      if (m.isSystem) {
        return ''
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
        <div class="chat-header-left">
          ${peersList || `<span class="status-text">${statusText}</span>`}
        </div>
      </div>
      <div class="messages" id="messages">${messagesHtml}</div>
      ${renderTypingIndicator()}
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
  document.getElementById('message-input')?.addEventListener('input', handleInputForTyping)
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

async function pollForQRCode(video: HTMLVideoElement): Promise<void> {
  if (!isScanning) return

  const result = scanQRCode(video)
  if (result && selectedPeerForVerification) {
    const peerPublicKey = connection?.getPeerPublicKey(selectedPeerForVerification)
    if (peerPublicKey) {
      const match = await fingerprintKey(peerPublicKey).then(fp => fp === result)
      if (match) {
        markAsVerified(currentRoomId, selectedPeerForVerification, peerPublicKey)
        addSystemMessage('Key verified successfully')
        stopQRScan()
      } else {
        addSystemMessage('Scanned key does not match')
        stopQRScan()
      }
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

function handleTyping(peerId: string, color: PeerColor): void {
  const existing = typingPeers.get(peerId)
  if (existing) clearTimeout(existing.timeout)

  const timeout = setTimeout(() => {
    typingPeers.delete(peerId)
    render()
  }, TYPING_TIMEOUT_MS)

  typingPeers.set(peerId, { color, timeout })
  render()
}

function handleInputForTyping(): void {
  const now = Date.now()
  if (now - lastTypingSent >= TYPING_THROTTLE_MS && connection) {
    lastTypingSent = now
    connection.sendTyping()
  }
}

async function handleCreateRoom(): Promise<void> {
  if (!await requestTermsAgreement()) return
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
  landingRoomId = roomId
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

  if (isRoomOccupied(roomId)) {
    status = 'Already connected to this room in another tab'
    render()
    return
  }

  await joinRoom(roomId)
}

async function joinRoom(roomId: string): Promise<void> {
  if (isRoomOccupied(roomId)) {
    status = 'Already connected to this room in another tab'
    currentView = 'landing'
    render()
    return
  }

  if (!await requestTermsAgreement()) return

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
      myColor = connection?.getMyColor() || myColor
      const stored = publicKey ? getStoredPeerKey(roomId, peerId, publicKey) : null
      const verified = stored?.status === 'verified'
      addNotification(color, 'has joined', verified)
    },
    (peerId, color, publicKey) => {
      canSend = connection?.canSend() || false
      myColor = connection?.getMyColor() || myColor
      const existing = typingPeers.get(peerId)
      if (existing) {
        clearTimeout(existing.timeout)
        typingPeers.delete(peerId)
      }
      const stored = publicKey ? getStoredPeerKey(roomId, peerId, publicKey) : null
      const verified = stored?.status === 'verified'
      addNotification(color, 'has left', verified)
    },
    (newStatus) => {
      canSend = connection?.canSend() || false
      if (newStatus === 'Disconnected from room' || newStatus === 'This room has expired') {
        onRoomLeft(roomId)
      }
      addSystemMessage(newStatus)
    },
    handleKeyChange,
    handleTyping
  )

  await newConnection.connect()

  connection = newConnection
  currentRoomId = roomId
  onRoomJoined(roomId)
  messageEncryptionKey = await newConnection.getMessageStorageKey()
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

  lastTypingSent = 0
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

async function init(): Promise<void> {
  initTheme()
  initTabSync()
  clearLegacyStorage()
  const url = new URL(window.location.href)

  if (url.searchParams.has('terms')) {
    currentView = 'terms'
    render()
    return
  }

  const roomId = url.searchParams.get('room')

  if (roomId) {
    landingRoomId = roomId
    const exists = await checkRoom(roomId)
    if (exists) {
      if (isRoomOccupied(roomId)) {
        status = 'Already connected to this room in another tab'
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
