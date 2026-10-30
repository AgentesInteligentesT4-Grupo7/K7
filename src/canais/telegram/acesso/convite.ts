import QRCode from 'qrcode';

/** Link de convite: abre o bot no Telegram e manda `/start <código>` quando a pessoa toca em Iniciar. */
export function inviteLink(botUsername: string, codigo: string): string {
  return `https://t.me/${botUsername.replace(/^@/, '')}?start=${codigo}`;
}

/** QR code do link em PNG (para mandar no Telegram, mostrar na página ou imprimir). */
export function qrPng(text: string): Promise<Buffer> {
  return QRCode.toBuffer(text, { type: 'png', errorCorrectionLevel: 'M', margin: 2, width: 512 });
}

/** QR code desenhado com caracteres, para mostrar no terminal. */
export function qrTerminal(text: string): Promise<string> {
  return QRCode.toString(text, { type: 'terminal', small: true, errorCorrectionLevel: 'M' });
}

/** QR code como imagem embutida (data URL), para páginas. */
export function qrDataUrl(text: string): Promise<string> {
  return QRCode.toDataURL(text, { errorCorrectionLevel: 'M', margin: 2, width: 320 });
}
