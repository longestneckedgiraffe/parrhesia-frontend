import QRCode from 'qrcode'
import jsQR from 'jsqr'

let scannerStream: MediaStream | null = null

export async function generateQRCode(publicKey: string): Promise<string> {
  return QRCode.toDataURL(publicKey, {
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

export function compareScannedKey(scannedKey: string, storedKey: string): boolean {
  return scannedKey === storedKey
}
