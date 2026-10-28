import type http from 'node:http';

/**
 * API que o tocador entrega à extensão de uma fita (`extensao/index.ts` com `export default function ativar(k7)`).
 * A extensão não importa nada do código do tocador: tudo o que ela usa vem deste objeto. Assim a fita leva o
 * próprio código (downloads, painéis, serviços) e o tocador fica só com o que é genérico.
 *
 * Copie este arquivo para a fita (ex.: `extensao/k7.d.ts`) para ter os tipos no editor.
 */
export interface FitaApi {
  fita: {
    nome: string;
    /** Pasta da fita (para ler arquivos dela, como o painel e os serviços). */
    dir: string;
    /** Pasta de trabalho da fita no tocador (`workspace/<fita>`): downloads, arquivos gerados. */
    workspaceDir: string;
    /** Pasta de dados da fita no tocador (`dados/<fita>`): o que ela precisa guardar. */
    dadosDir: string;
    /** Ambiente da fita (`.env` do tocador + `.env` da fita): configurações e segredos. */
    env: Readonly<Record<string, string | undefined>>;
  };
  log: { info(msg: string): void; aviso(msg: string): void; erro(msg: string): void };
  /**
   * Ferramenta que o agente pode usar (como baixar um link). Erros com `userMessage` (texto) chegam à pessoa
   * como estão, no chat, no Telegram e na página; os demais viram "falha interna".
   */
  ferramenta(tool: FitaTool): void;
  web: {
    /** Rota da API do chat web. O caminho precisa começar com `/api/x/` (espaço das extensões). */
    rota(metodo: 'GET' | 'POST' | 'DELETE', caminho: RegExp, handler: (ctx: WebRotaCtx) => Promise<void> | void, opcoes?: { visitante?: boolean }): void;
    /** Script e estilo (arquivos da fita) incluídos na página do chat; o script recebe `window.K7`. */
    painel(arquivos: { script?: string; estilo?: string }): void;
  };
  /** Comando de linha de comando: `npm run fita -- <fita> <comando> [args]`. */
  comando(nome: string, descricao: string, executar: (args: string[]) => Promise<void>): void;
  /** Roda depois de a fita carregar (ex.: conferir se um serviço está no ar). Erros só viram aviso no log. */
  aoIniciar(fn: () => Promise<void> | void): void;
  util: {
    /** No máximo `max` tarefas por chave ao mesmo tempo; as demais esperam. */
    limitador(max: number): { run<T>(chave: string, tarefa: () => Promise<T>): Promise<T> };
    /** Roda `tarefa` para cada item com até `max` ao mesmo tempo; o resultado sai na ordem. */
    emParalelo<T, R>(itens: T[], max: number, tarefa: (item: T, i: number) => Promise<R>): Promise<R[]>;
  };
}

export interface FitaTool {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description?: string; enum?: string[]; items?: { type: string } }>;
    required?: string[];
    additionalProperties?: boolean;
  };
  /** Devolve o texto que o agente lê (o resultado da ação). */
  run(args: Record<string, unknown>, ctx: FitaToolCtx): Promise<string>;
}

export interface FitaToolCtx {
  /** Quem pediu (Telegram, visitante do chat web...); ausente fora de uma conversa. */
  userId?: string;
  /** Andamento na tela enquanto a resposta não chega ("Baixando 3 de 10…"; com números, barra de %). */
  progresso(texto: string, contagem?: { done: number; total: number }): void;
  limparProgresso(): void;
  /** Entrega um arquivo de áudio ou vídeo junto da resposta (Telegram, terminal ou navegador). */
  anexarMidia(caminho: string, tipo: 'audio' | 'video'): void;
}

export interface WebRotaCtx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  /** Grupos da expressão do caminho. */
  params: string[];
  /** Visitante (ou o dono, fora do modo público); vazio nas rotas com `visitante: false`. */
  userId: string;
  publico: boolean;
  /** Dispara quando a pessoa fecha a página antes da resposta terminar. */
  saiu: AbortSignal;
  json(dados: unknown, status?: number): void;
  /** Áudio/vídeo com Range (o player pula para qualquer ponto). */
  midia(arquivo: string, nome: string): void;
  /** Vários arquivos num .zip, montado enquanto é enviado. */
  zip(arquivos: Array<{ name: string; path: string }>, nome: string): Promise<void>;
  lerJson(): Promise<unknown>;
  /** Encerra com erro HTTP (status e mensagem para a página). */
  falhar(status: number, mensagem: string): never;
  /** Uma tarefa por vez por visitante (como as mensagens). */
  emFila<T>(tarefa: () => Promise<T>): Promise<T>;
  /** Andamento do visitante, lido pela página em /api/progresso (com números, barra de %). */
  progresso(texto: string, contagem?: { done: number; total: number }): void;
  limparProgresso(): void;
}
