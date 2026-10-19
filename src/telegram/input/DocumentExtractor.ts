import fs from 'node:fs';
import { PDFParse } from 'pdf-parse';

/** Strategy de extração de texto por tipo de documento. */
export interface IDocumentExtractor {
  readonly extension: string;
  supports(fileName: string, mimeType: string | undefined): boolean;
  extract(filePath: string): Promise<string>;
}

export class PdfExtractor implements IDocumentExtractor {
  readonly extension = '.pdf';

  supports(fileName: string, mimeType: string | undefined): boolean {
    return mimeType === 'application/pdf' || fileName.toLowerCase().endsWith('.pdf');
  }

  async extract(filePath: string): Promise<string> {
    const data = await fs.promises.readFile(filePath);
    const parser = new PDFParse({ data });
    try {
      const result = await parser.getText();
      return result.text;
    } finally {
      await parser.destroy();
    }
  }
}

export class MarkdownExtractor implements IDocumentExtractor {
  readonly extension = '.md';

  supports(fileName: string, mimeType: string | undefined): boolean {
    const name = fileName.toLowerCase();
    return name.endsWith('.md') || name.endsWith('.markdown') || mimeType === 'text/markdown';
  }

  async extract(filePath: string): Promise<string> {
    return fs.promises.readFile(filePath, 'utf8');
  }
}

/** Seleciona o extractor adequado ao anexo (apenas PDF e Markdown são suportados). */
export class DocumentExtractor {
  constructor(private readonly extractors: IDocumentExtractor[] = [new PdfExtractor(), new MarkdownExtractor()]) {}

  find(fileName: string | undefined, mimeType: string | undefined): IDocumentExtractor | undefined {
    return this.extractors.find((extractor) => extractor.supports(fileName ?? '', mimeType));
  }
}
