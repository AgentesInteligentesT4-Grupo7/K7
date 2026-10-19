import fs from 'node:fs';
import path from 'node:path';
import { errorMessage } from '../../../errors/AppErrors.js';
import { Logger } from '../../../utils/Logger.js';
import type { TempFileManager } from '../../../utils/TempFileManager.js';
import type { GeneratedFile } from '../FileTagParser.js';
import type { TelegramSender } from '../TelegramSender.js';
import type { IOutputStrategy } from './OutputStrategy.js';

/** Grava o documento gerado em ./tmp, envia como anexo e apaga o temporário. */
export class FileOutputStrategy implements IOutputStrategy<GeneratedFile> {
  private readonly logger = new Logger('FileOutput');

  constructor(
    private readonly sender: TelegramSender,
    private readonly tmp: TempFileManager,
    private readonly textFallback: IOutputStrategy<string>,
  ) {}

  async send(chatId: number, file: GeneratedFile): Promise<void> {
    const tmpPath = this.tmp.createPath(path.extname(file.filename) || '.md');
    try {
      try {
        await fs.promises.writeFile(tmpPath, file.content, 'utf8');
      } catch (error) {
        // EC-02: sem permissão/espaço no ./tmp → entrega o conteúdo como texto.
        this.logger.warn(`Não foi possível gravar ${file.filename} no tmp: ${errorMessage(error)}`);
        await this.textFallback.send(chatId, `⚠️ Não consegui gerar o arquivo, segue texto puro:\n\n${file.content}`);
        return;
      }
      await this.sender.sendDocument(chatId, tmpPath, file.filename, `📄 ${file.filename}`);
      this.logger.info(`📎 Documento enviado: ${file.filename} (${Buffer.byteLength(file.content, 'utf8')} bytes)`);
    } finally {
      await this.tmp.remove(tmpPath);
    }
  }
}
