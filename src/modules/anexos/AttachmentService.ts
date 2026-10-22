import { PDFParse } from 'pdf-parse';
import { UserFacingError, errorMessage } from '../../errors/AppErrors.js';
import { TaskContext } from '../../llm/orchestration/TaskContext.js';
import type { ILlmProvider, ImagePart } from '../../llm/types.js';
import { Logger } from '../../utils/Logger.js';
import { sanitizeText } from '../../utils/text.js';
import { decodeBody, htmlToText } from '../pesquisa-web/HtmlText.js';
import { type Attachment, type AttachmentPart, type AttachmentStore, kindOf } from './AttachmentStore.js';

export interface IngestedAttachment {
  attachment: Attachment;
  duplicate: boolean;
  /** Texto extraído (documentos); imagens não têm texto até o OCR sob demanda. */
  text: string;
}

export interface AttachmentServiceOptions {
  /** Documentos menores que isso entram inteiros na mensagem (RF-04). */
  inlineChars: number;
  /** Trecho inicial de documentos maiores. */
  excerptChars: number;
  maxImageBytes: number;
}

const KIND_LABEL = { image: 'imagem', pdf: 'PDF', text: 'texto', other: 'arquivo' } as const;
const TRANSCRIBE_PROMPT =
  'Transcreva fielmente todo o texto visível nesta imagem, na ordem de leitura, mantendo acentos, números e quebras de linha. ' +
  'Não resuma nem comente. Se não houver texto, responda exatamente: [sem texto].';

/**
 * Anexos do módulo "anexos" (spec attachments): guarda o arquivo, extrai o texto e monta a entrada do agente com
 * referência + trecho (não o documento inteiro). OCR e análise de imagem usam um modelo com visão, sob demanda.
 */
export class AttachmentService {
  private readonly logger = new Logger('Anexos');

  constructor(
    readonly store: AttachmentStore,
    private readonly llm: ILlmProvider,
    private readonly options: AttachmentServiceOptions = { inlineChars: 6_000, excerptChars: 1_500, maxImageBytes: 10 * 1024 * 1024 },
  ) {}

  /** Tipo suportado para ingestão (imagem, PDF ou texto). */
  static supports(name: string, mime?: string): boolean {
    return kindOf(name, mime) !== 'other';
  }

  async ingest(input: { userId: string; name: string; mime: string; data: Buffer; caption?: string }): Promise<IngestedAttachment> {
    const { attachment, duplicate } = this.store.save(input);
    let parts = this.store.texts(attachment.id);
    if (!parts.length && attachment.kind !== 'image') {
      parts = await this.extract(attachment, input.data);
      this.store.setText(attachment.id, parts);
    }
    this.logger.info(`📎 Anexo #${attachment.id} ${attachment.name} (${KIND_LABEL[attachment.kind]}${duplicate ? ', já existia' : ''})`);
    return { attachment: this.store.get(input.userId, attachment.id)!, duplicate, text: parts.map((p) => p.text).join('\n\n') };
  }

  /** Mensagem do usuário: legenda + referência a cada anexo (+ texto/trecho) e as imagens para visão. */
  buildInput(items: IngestedAttachment[], caption: string): { text: string; images: ImagePart[]; attachmentName: string } {
    const hasImage = items.some((i) => i.attachment.kind === 'image');
    const intro = caption.trim() || (items.length > 1 ? 'Analise os anexos.' : hasImage ? 'Analise a imagem anexada.' : 'Analise o documento anexado.');
    const blocks = items.map(({ attachment: a, duplicate, text }) => {
      const size = a.kind === 'image' ? '' : ` · ${a.extractedChars.toLocaleString('pt-BR')} caracteres`;
      const header = `[Anexo #${a.id}: ${a.name} · ${KIND_LABEL[a.kind]}${size}${duplicate ? ' · já estava na biblioteca' : ''}]`;
      if (a.kind === 'image') return header;
      if (!text.trim()) return `${header}\n[Documento sem texto extraível]`;
      if (text.length <= this.options.inlineChars) return `${header}\n${text}`;
      return `${header}\n${text.slice(0, this.options.excerptChars)}\n[... trecho inicial; leia o restante com ler_anexo(${a.id}) ...]`;
    });
    const images = items
      .filter((i) => i.attachment.kind === 'image' && i.attachment.sizeBytes <= this.options.maxImageBytes)
      .map((i) => ({ mime: i.attachment.mime || 'image/jpeg', base64: this.store.readFile(i.attachment).toString('base64') }));
    return { text: `${intro}\n\n${blocks.join('\n\n')}`, images, attachmentName: items.map((i) => i.attachment.name).join(', ') };
  }

  /** Texto de um anexo; imagem sem texto passa pelo OCR por visão e o resultado fica em cache. */
  async text(userId: string, attachment: Attachment): Promise<AttachmentPart[]> {
    const parts = this.store.texts(attachment.id);
    if (parts.length || attachment.kind !== 'image') return parts;
    const transcript = (await this.askVision(userId, attachment, TRANSCRIBE_PROMPT)).trim();
    const text = transcript === '[sem texto]' ? '' : transcript;
    const ocr = [{ label: 'imagem', source: 'ocr:visao', text }];
    this.store.setText(attachment.id, ocr);
    return ocr;
  }

  analyzeImage(userId: string, attachment: Attachment, question: string): Promise<string> {
    if (attachment.kind !== 'image') throw new UserFacingError(`O anexo #${attachment.id} não é uma imagem.`);
    return this.askVision(userId, attachment, question);
  }

  /**
   * Consulta avulsa a um modelo com visão, em contexto próprio: não troca o modelo "fixado" da conversa
   * (o orquestrador escolhe um gratuito com visão; a cadeia fixa tenta os providers em ordem).
   */
  private async askVision(userId: string, attachment: Attachment, question: string): Promise<string> {
    const image = { mime: attachment.mime || 'image/jpeg', base64: this.store.readFile(attachment).toString('base64') };
    const privacy = TaskContext.current()?.privacy ?? 'publico';
    try {
      const response = await TaskContext.run({ task: 'visao', privacy, userId }, () =>
        this.llm.chat({ messages: [{ role: 'user', content: question, images: [image] }], temperature: 0 }),
      );
      return response.content ?? '';
    } catch (error) {
      throw new UserFacingError(
        'Nenhum modelo com visão respondeu agora (Gemini fora do ar ou sem cota?). Tente de novo mais tarde.',
        `Visão falhou para o anexo #${attachment.id}: ${errorMessage(error)}`,
      );
    }
  }

  private async extract(attachment: Attachment, data: Buffer): Promise<AttachmentPart[]> {
    try {
      if (attachment.kind === 'pdf') {
        const parser = new PDFParse({ data: new Uint8Array(data) });
        try {
          const result = await parser.getText();
          const pages = result.pages.map((p) => ({ label: `p. ${p.num}`, source: 'pdf', text: sanitizeText(p.text).trim() })).filter((p) => p.text);
          return pages.length ? pages : [];
        } finally {
          await parser.destroy();
        }
      }
      const raw = decodeBody(data, attachment.mime);
      const text = /html?$/i.test(attachment.name) || attachment.mime.includes('html') ? htmlToText(raw) : raw;
      return [{ label: 'texto', source: 'arquivo', text: sanitizeText(text).trim() }];
    } catch (error) {
      this.logger.warn(`Não consegui extrair o texto do anexo #${attachment.id}: ${errorMessage(error)}`);
      return [];
    }
  }
}
