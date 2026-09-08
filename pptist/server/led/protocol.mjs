import crypto from 'node:crypto'

export function createDisplayPayload(revision, screen) {
  return {
    protocol: 'led-display/1.0',
    type: 'display',
    msg_id: crypto.randomBytes(4).toString('hex'),
    revision,
    role: screen.role,
    image: {
      url: screen.url,
      format: 'jpeg',
      width: 1280,
      height: 800,
      sha256: screen.sha256,
    },
  }
}
