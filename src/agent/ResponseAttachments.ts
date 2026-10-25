import { AsyncLocalStorage } from 'node:async_hooks';

/** Imagem gerada por uma ferramenta durante a requisição, entregue pelo canal junto da resposta. */
export interface GeneratedImage {
  /** Caminho absoluto do PNG no workspace. */
  path: string;
  caption?: string;
}

/** Áudio, vídeo ou outro arquivo produzido por uma ferramenta (ex.: download do módulo midia). */
export interface GeneratedMedia {
  /** Caminho absoluto do arquivo no workspace. */
  path: string;
  kind: 'audio' | 'video' | 'document';
  caption?: string;
}

interface Attachments {
  images: GeneratedImage[];
  media: GeneratedMedia[];
}

const storage = new AsyncLocalStorage<Attachments>();

/**
 * Mídia produzida pelas ferramentas no ciclo atual do agente. Não depende de o LLM repetir
 * o caminho do arquivo na resposta: o AgentController coleta e o canal entrega.
 */
export const ResponseAttachments = {
  async collect<T>(fn: () => Promise<T>): Promise<{ result: T; images: GeneratedImage[]; media: GeneratedMedia[] }> {
    const attachments: Attachments = { images: [], media: [] };
    const result = await storage.run(attachments, fn);
    return { result, images: attachments.images, media: attachments.media };
  },
  /** Chamado pela ferramenta; fora de uma requisição (ex.: testes, eval), é ignorado. */
  addImage(image: GeneratedImage): void {
    storage.getStore()?.images.push(image);
  },
  addMedia(media: GeneratedMedia): void {
    storage.getStore()?.media.push(media);
  },
};
