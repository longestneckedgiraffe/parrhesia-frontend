import './styles/style.css'
import type { ChatConnection } from './network/websocket'
import { createRoom, checkRoom, RoomAccessError } from './network/rooms'
import type { PeerColor } from './crypto/crypto'
import { getStoredPeerKey, markAsVerified, generateSafetyNumber } from './crypto/tofu'
import { generateQRCode, initializeScanner, scanQRCode, stopScanner, fingerprintKey } from './utils/qr'
import { initTabSync, isRoomOccupied, onRoomJoined, onRoomLeft } from './utils/tabSync'
import { renderLandingPage, renderTermsPage } from './publicPages'
import { getCurrentEffectiveTheme, toggleTheme, initTheme } from './theme'
import termsMarkdown from './content/terms.md?raw'

const TERMS_VERSION = '2026-09-16'
const TERMS_AGREEMENT_STORAGE_KEY = 'parrhesia-terms-agreement'

interface TermsAgreement {
  version: string
  agreedAt: string
}

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
  const { encryptMessages } = await import('./crypto/crypto')
  const encrypted = await encryptMessages(messages, messageEncryptionKey)
  localStorage.setItem(getStorageKey(currentRoomId), JSON.stringify(encrypted))
}

async function loadMessages(roomId: string): Promise<Message[]> {
  const stored = localStorage.getItem(getStorageKey(roomId))
  if (!stored) return []
  try {
    const { isEncryptedData, decryptMessages } = await import('./crypto/crypto')
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
let roomActionPending = false
let showPasswordModal = false
let passwordError = ''
let passwordResolver: ((password: string | null) => void) | null = null

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
let chatRuntime: Promise<typeof import('./network/websocket')> | null = null

function loadChatRuntime(): Promise<typeof import('./network/websocket')> {
  if (!chatRuntime) {
    chatRuntime = Promise.all([import('./network/websocket'), import('./crypto/crypto')])
      .then(([network, crypto]) => {
        crypto.clearLegacyStorage()
        initTabSync()
        return network
      })
      .catch(() => {
        chatRuntime = null
        throw new RoomAccessError('Unable to load chat. Please try again.')
      })
  }
  return chatRuntime
}

function setRoomMetadata(): void {
  let robots = document.querySelector<HTMLMetaElement>('meta[name="robots"]')
  if (!robots) {
    robots = document.createElement('meta')
    robots.name = 'robots'
    document.head.append(robots)
  }
  robots.content = 'noindex'
  document.title = 'parrhesia'
  document.querySelector('link[rel="canonical"]')?.remove()
  document.querySelector('meta[property="og:url"]')?.remove()
  document.querySelector('script[type="application/ld+json"]')?.remove()
  document.querySelector('meta[property="og:title"]')?.setAttribute('content', 'parrhesia')
  document.querySelector('meta[property="og:description"]')?.setAttribute('content', 'end-to-end encrypted chat')
  document.querySelector('meta[name="description"]')?.setAttribute('content', 'end-to-end encrypted chat')
}

function render(): void {
  const app = document.querySelector<HTMLDivElement>('#app')!
  const existingInput = document.getElementById('message-input') as HTMLInputElement | null
  const existingRoomInput = document.getElementById('room-input') as HTMLInputElement | null
  const existingPasswordInput = document.getElementById('room-password') as HTMLInputElement | null
  let savedPassword = existingPasswordInput?.value || ''
  const savedValue = existingInput?.value || ''
  if (existingRoomInput) landingRoomId = existingRoomInput.value

  document.body.classList.toggle('terms-page', currentView === 'terms')
  document.body.classList.toggle('landing-page', currentView === 'landing')

  if (currentView === 'landing') {
    renderLanding(app)
    const passwordInput = document.getElementById('room-password') as HTMLInputElement
    passwordInput.value = savedPassword
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
  savedPassword = ''

  if (showTermsAgreementModal && currentView === 'landing') {
    app.insertAdjacentHTML('beforeend', renderTermsAgreementModal())
    bindTermsAgreementModal()
  }
  if (showPasswordModal && currentView === 'landing') {
    app.insertAdjacentHTML('beforeend', renderPasswordModal())
    bindPasswordModal()
  }
}

function renderLanding(app: HTMLDivElement): void {
  const theme = getCurrentEffectiveTheme()

  app.innerHTML = renderLandingPage({
    disabled: roomActionPending,
    inert: showTermsAgreementModal || showPasswordModal,
    status: Boolean(status),
    theme
  })
  const roomInput = document.getElementById('room-input') as HTMLInputElement
  roomInput.value = landingRoomId
  const statusElement = document.getElementById('room-status')
  if (statusElement) statusElement.textContent = status
  document.getElementById('create-room')?.addEventListener('click', handleCreateRoom)
  document.getElementById('join-room')?.addEventListener('click', handleJoinRoom)
  document.getElementById('room-input')?.addEventListener('keypress', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') handleJoinRoom()
  })
  document.getElementById('room-password')?.addEventListener('keypress', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') handleJoinRoom()
  })
  document.getElementById('source-toggle')?.addEventListener('click', () => {
    const expanded = document.querySelector('.source-links')?.classList.toggle('visible')
    document.getElementById('source-toggle')?.setAttribute('aria-expanded', String(Boolean(expanded)))
  })
  document.getElementById('theme-toggle')?.addEventListener('click', () => {
    toggleTheme()
    render()
  })
}

function renderTerms(app: HTMLDivElement): void {
  const theme = getCurrentEffectiveTheme()

  app.innerHTML = renderTermsPage(termsMarkdown, theme)
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
        <div class="verification-info" id="terms-agreement-description">To create or join a room, confirm that you meet the age requirement and agree to the <a href="/terms/" target="_blank">terms of service</a>.</div>
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

function renderPasswordModal(): string {
  return `
    <div class="modal-overlay" id="password-overlay">
      <form class="modal-panel verification-panel" id="password-panel" role="dialog" aria-modal="true" aria-label="Room password" aria-describedby="password-description">
        <div class="verification-header">
          <button type="button" class="close-link" id="cancel-password">Cancel</button>
        </div>
        <div class="verification-info" id="password-description">This room is password protected. Enter its password to join.</div>
        <input type="password" class="password-input" id="join-password" placeholder="password" aria-label="Room password" autocomplete="current-password" required ${passwordError ? 'aria-describedby="password-error" aria-invalid="true"' : ''}>
        ${passwordError ? '<div class="password-error" id="password-error" role="alert"></div>' : ''}
        <div class="verification-actions">
          <button type="submit" class="action-link" id="submit-password">Join</button>
        </div>
      </form>
    </div>
  `
}

function bindPasswordModal(): void {
  const input = document.getElementById('join-password') as HTMLInputElement
  const errorElement = document.getElementById('password-error')
  if (errorElement) errorElement.textContent = passwordError
  input.focus()
  document.getElementById('password-panel')?.addEventListener('submit', (event) => {
    event.preventDefault()
    if (input.value) resolvePassword(input.value)
  })
  document.getElementById('password-panel')?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') resolvePassword(null)
    if (event.key !== 'Tab') return
    const first = document.getElementById('cancel-password')!
    const last = document.getElementById('submit-password')!
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  })
  document.getElementById('cancel-password')?.addEventListener('click', () => resolvePassword(null))
  document.getElementById('password-overlay')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) resolvePassword(null)
  })
}

function requestPassword(error = ''): Promise<string | null> {
  passwordError = error
  showPasswordModal = true
  return new Promise(resolve => {
    passwordResolver = resolve
    render()
  })
}

function resolvePassword(password: string | null): void {
  const input = document.getElementById('join-password') as HTMLInputElement | null
  if (input) input.value = ''
  showPasswordModal = false
  passwordError = ''
  const resolve = passwordResolver
  passwordResolver = null
  render()
  resolve?.(password)
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
      <button type="button" id="theme-toggle" class="link-button">${theme}</button>
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
  if (roomActionPending) return
  roomActionPending = true
  let password = takeLandingPassword()
  try {
    if (!await requestTermsAgreement()) return
    status = 'Creating room...'
    render()
    await loadChatRuntime()
    const room = await createRoom(password)
    landingRoomId = room.roomId
    const input = document.getElementById('room-input') as HTMLInputElement | null
    if (input) input.value = room.roomId
    const joining = joinRoom(room.roomId, room.passwordRequired, password)
    password = ''
    await joining
  } catch (error) {
    status = error instanceof RoomAccessError ? error.message : 'Unable to create room'
  } finally {
    password = ''
    roomActionPending = false
    render()
  }
}

async function handleJoinRoom(): Promise<void> {
  if (roomActionPending) return
  const input = document.getElementById('room-input') as HTMLInputElement
  const roomId = input.value.trim()
  landingRoomId = roomId
  if (!roomId) {
    status = 'Please enter a room ID'
    render()
    return
  }
  await joinExistingRoom(roomId)
}

function takeLandingPassword(): string {
  const input = document.getElementById('room-password') as HTMLInputElement | null
  const password = input?.value || ''
  if (input) input.value = ''
  return password
}

async function joinExistingRoom(roomId: string, fromLink = false): Promise<void> {
  if (roomActionPending) return
  roomActionPending = true
  let password = takeLandingPassword()
  try {
    if (isRoomOccupied(roomId)) {
      throw new RoomAccessError('Already connected to this room in another tab')
    }
    status = 'Checking room...'
    render()
    const room = await checkRoom(roomId)
    if (!room.exists) throw new RoomAccessError('Room does not exist or has expired')
    if (!await requestTermsAgreement()) {
      status = ''
      return
    }
    let errorMessage = ''
    while (true) {
      if (fromLink && room.passwordRequired) {
        status = ''
        let enteredPassword = await requestPassword(errorMessage)
        if (enteredPassword === null) return
        password = enteredPassword
        enteredPassword = ''
      }
      if (room.passwordRequired && !password) {
        throw new RoomAccessError('Please enter this room\'s password', 'password_required')
      }
      try {
        const joining = joinRoom(roomId, room.passwordRequired, password)
        password = ''
        await joining
        return
      } catch (error) {
        if (!fromLink || !room.passwordRequired || !(error instanceof RoomAccessError) || !error.canRetryPassword) {
          throw error
        }
        errorMessage = error.message
      }
    }
  } catch (error) {
    status = error instanceof RoomAccessError ? error.message : 'Unable to join room. Please try again.'
  } finally {
    password = ''
    roomActionPending = false
    render()
    if (currentView === 'landing') document.getElementById('room-password')?.focus()
  }
}

async function joinRoom(roomId: string, passwordRequired: boolean, password: string): Promise<void> {
  if (isRoomOccupied(roomId)) {
    throw new RoomAccessError('Already connected to this room in another tab')
  }

  canSend = false
  status = 'Joining room...'
  render()

  const { ChatConnection } = await loadChatRuntime()
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
      canSend = newConnection.canSend()
      status = newStatus
      if (currentRoomId === roomId && newConnection.isClosed()) {
        onRoomLeft(roomId)
      }
      addSystemMessage(newStatus)
    },
    handleKeyChange,
    handleTyping
  )

  try {
    messageEncryptionKey = await newConnection.prepare()
    messages = await loadMessages(roomId)
    const connecting = newConnection.connect(passwordRequired, password)
    password = ''
    await connecting
    if (newConnection.isClosed()) throw new RoomAccessError('Disconnected from room')
    connection = newConnection
    currentRoomId = roomId
    onRoomJoined(roomId)
    myPeerId = connection.getPeerId()
    myColor = connection.getMyColor()
    canSend = connection.canSend()
    currentView = 'chat'
    setRoomMetadata()
    render()
  } catch (error) {
    newConnection.disconnect()
    messageEncryptionKey = null
    messages = []
    throw error
  } finally {
    password = ''
  }

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
  const url = new URL(window.location.href)

  if (url.searchParams.has('room')) setRoomMetadata()

  const legacyTerms = (url.pathname === '/' || url.pathname === '/index.html') && url.searchParams.has('terms')
  if (url.pathname === '/terms/' || legacyTerms) {
    currentView = 'terms'
    render()
    return
  }

  if (url.pathname !== '/' && url.pathname !== '/index.html' && url.pathname !== '/room.html') return

  const roomId = url.searchParams.get('room')

  if (roomId) {
    landingRoomId = roomId
    await joinExistingRoom(roomId, true)
    return
  }

  render()
}

init()
