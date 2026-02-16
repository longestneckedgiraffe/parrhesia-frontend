import QRCode from 'qrcode'
import jsQR from 'jsqr'

let scannerStream: MediaStream | null = null

export async function fingerprintKey(publicKey: string): Promise<string> {
  const data = new TextEncoder().encode(publicKey)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
}

export async function generateQRCode(publicKey: string): Promise<string> {
  const fingerprint = await fingerprintKey(publicKey)
  return QRCode.toDataURL(fingerprint, {
    width: 200,
    margin: 2,
    errorCorrectionLevel: 'M'
  })
}

export async function initializeScanner(videoElement: HTMLVideoElement): Promise<void> {
  scannerStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'environment' }
  })
  videoElement.srcObject = scannerStream
}

export function scanQRCode(videoElement: HTMLVideoElement): string | null {
  if (videoElement.videoWidth === 0 || videoElement.videoHeight === 0) {
    return null
  }

  const canvas = document.createElement('canvas')
  canvas.width = videoElement.videoWidth
  canvas.height = videoElement.videoHeight

  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  ctx.drawImage(videoElement, 0, 0)
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)

  const code = jsQR(imageData.data, imageData.width, imageData.height)
  return code?.data || null
}

export function stopScanner(videoElement: HTMLVideoElement): void {
  if (scannerStream) {
    scannerStream.getTracks().forEach(track => track.stop())
    scannerStream = null
  }
  videoElement.srcObject = null
}

export async function compareScannedKey(scannedFingerprint: string, publicKey: string): Promise<boolean> {
  const fingerprint = await fingerprintKey(publicKey)
  return scannedFingerprint === fingerprint
}
