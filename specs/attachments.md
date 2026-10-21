# Spec: Anexos — Imagens, Documentos, OCR e Biblioteca de Arquivos

**Versão:** 1.0
**Status:** Em Revisão
**Autor:** AgroMinds Agent
**Data:** 2026-10-19
**Reviewers:** Agro

---

## 1. Resumo

Permite que o AgroMinds **entenda imagens** (explicar, responder sobre elas ou extrair o texto via OCR), **leia documentos** em vários formatos (PDF digital ou escaneado, Word, Excel, PowerPoint, texto) e **guarde tudo numa biblioteca de anexos**, para que o usuário possa voltar a falar de um arquivo enviado antes ("naquela imagem de ontem...", "use os documentos 2 e 3 para...") sem reenviar.

---

## 2. Contexto e Motivação

**Problema (estado atual do código):**
- **Imagens são recusadas.** Foto ou imagem cai no `handleUnsupported` e o usuário recebe "só consigo processar texto estruturado (.md), áudio e PDF". A imagem nem chega a ser baixada (`telegram-input` NG-01 excluiu imagens do escopo).
- **Só PDF e `.md` são lidos.** Word, Excel, PowerPoint e outros formatos são recusados.
- **PDF escaneado vira vazio.** O `pdf-parse` só lê a camada de texto; páginas que são imagem resultam em `[Documento sem texto extraível]`.
- **O arquivo é apagado depois de ler.** O documento fica em `./tmp` só durante a extração; o texto inteiro é colado na mensagem do usuário. Não dá para consultar o arquivo de novo, escolher entre vários, nem rever uma imagem.
- **O documento inteiro entra no histórico.** Um PDF de 40 mil caracteres vai para o contexto de todas as mensagens seguintes (conflita com `memory` v1.1).

**Evidências:**
- Pedido do usuário (2026-10-19): imagens que precisam de OCR ou de explicação, documentos Word/Excel/PDF, resumir ou escolher entre vários documentos, voltar a uma imagem já enviada.
- O OCR do projeto **pdfcraft** (`crates/ocr`, engine `ocrs` + `rten`) declara que os modelos leem "o alfabeto latino (**inglês e outras línguas escritas sem acentos**)". O próprio [ocrs](https://github.com/robertknight/ocrs) confirma: "currently recognizes the Latin alphabet only (eg. English)"; outros idiomas estão apenas planejados, sem prazo. Em português, "ação" e "atenção" perderiam os acentos e o "ç".
- No pdfcraft, a **GPU é usada só para desenhar a interface** (`wgpu`/`egui`). O OCR (`ocrs` + `rten`) roda na CPU; o `rten` não tem backend de GPU.
- O `servico_paddle_ocr` existente usa o **PaddleOCR-VL** (modelo de visão-linguagem de ~0,9 B parâmetros) e foi avaliado pelo usuário como **lento demais** para uso interativo.
- A família clássica **PP-OCRv5** tem a mesma arquitetura em dois estágios do ocrs (detecção de linhas + reconhecimento), com modelo de reconhecimento **Latin** que cobre o português com acentos ([PP-OCRv5 multilíngue](https://www.paddleocr.ai/v3.3.2/en/version3.x/algorithm/PP-OCRv5/PP-OCRv5_multi_languages.html)), publicado em ONNX ([`latin_PP-OCRv5_mobile_rec.onnx`, ~7,5 MB](https://huggingface.co/monkt/paddleocr-onnx)) e executável no Node via `onnxruntime-node` (pacotes [`paddleocr`](https://cdn.jsdelivr.net/npm/paddleocr@1.1.1/README.md) e `ppu-paddle-ocr`).

**Por que agora:**
O Gemini (provider principal) já é multimodal, e um OCR leve em português (PP-OCRv5 Latin) roda dentro do próprio processo Node, sem serviço externo. Falta só ligar as peças e guardar os anexos.

---

## 3. Goals (Objetivos)

- [ ] G-01: Receber imagens (foto comprimida, imagem como arquivo e álbuns) e responder sobre elas com um LLM com visão.
- [ ] G-02: Extrair texto de imagens e páginas escaneadas com **OCR local em português, rápido e na GPU** (PP-OCRv5 Latin em ONNX, no mesmo modelo de dois estágios do pdfcraft).
- [ ] G-03: Ler documentos: PDF (digital e escaneado), DOCX, XLSX/CSV, PPTX, TXT/MD/HTML/JSON.
- [ ] G-04: **Biblioteca de anexos** persistente, com ID, consulta posterior e seleção de vários arquivos para uma tarefa.
- [ ] G-05: O agente lê os anexos **sob demanda**, por ferramentas, em vez de colar documentos inteiros no histórico.

**Métricas de sucesso:**
| Métrica | Baseline atual | Target | Prazo |
|---------|---------------|--------|-------|
| Imagens respondidas corretamente (conjunto de 20: recibos, prints, fotos, gráficos) | 0% (recusadas) | ≥ 90% | MVP |
| Taxa de erro de caracteres do OCR em documentos pt-BR impressos | N/A | ≤ 3% | MVP |
| Formatos de documento aceitos | 2 (PDF, MD) | 8+ | MVP |
| Referência a anexo antigo sem reenviar ("o PDF de ontem") | Impossível | Funciona até `ATTACHMENTS_RETENTION_DAYS` | MVP |
| Caracteres de documento que entram no histórico por anexo | Texto inteiro | ≤ 2.000 (referência + trecho) | MVP |

---

## 4. Non-Goals (Fora do Escopo)

- NG-01: Vídeos e GIFs animados (só o primeiro quadro, se necessário, em versão futura).
- NG-02: Gerar ou editar imagens.
- NG-03: Garantir leitura de **letra cursiva**. O Gemini lê razoavelmente bem, mas sem meta de acurácia; o PP-OCRv5 é treinado para texto impresso.
- NG-04: Arquivos acima de **20 MB** (limite de download da Bot API do Telegram; um servidor Bot API local poderia ampliar, em versão futura).
- NG-05: Executar macros ou scripts de arquivos Office. São lidos apenas como dados.
- NG-06: Busca semântica (embeddings) nos anexos. A busca é por palavras (FTS5), alinhada ao NG-03 da spec de memória.

---

## 5. Usuários e Personas

**Usuário primário:** Agro, pelo Telegram ou pelo terminal (`/arquivo`, `/imagem`). Manda prints, fotos de documentos e recibos, PDFs de artigos e relatórios, planilhas e apresentações, e depois pede resumos, comparações, extrações ou explicações, às vezes dias depois.

---

## 6. Requisitos Funcionais

### 6.1 Requisitos Principais

| ID | Requisito | Prioridade | Critério de Aceite |
|----|-----------|-----------|-------------------|
| RF-01 | **Receber imagens:** `message:photo` (usa a maior resolução), imagem enviada como arquivo (PNG, JPG, WEBP; HEIC convertido) e **álbuns** (`media_group_id`: as fotos chegam como mensagens separadas e são agrupadas numa única entrada, com janela de ~2 s). | Must | Um álbum de 3 fotos com legenda "compare" gera **uma** entrada com 3 anexos. |
| RF-02 | **Biblioteca de anexos:** todo arquivo recebido é salvo em `ATTACHMENTS_DIR/<usuário>/<AAAA-MM>/<id>-<nome>` e registrado na tabela `attachments` (tipo, nome, tamanho, sha256, legenda, data). Arquivo idêntico (mesmo sha256) não é duplicado. | Must | Reenviar o mesmo PDF reaproveita o anexo existente. |
| RF-03 | **Processamento por tipo (Strategy)**, executado no recebimento e guardado em cache: imagem → OCR + descrição curta; PDF → texto por página, com OCR nas páginas sem camada de texto; DOCX → texto com títulos; XLSX/CSV → abas em tabelas (limite de linhas e resumo das colunas); PPTX → texto por slide; TXT/MD/HTML/JSON → texto. | Must | Um PDF escaneado de 5 páginas devolve texto nas 5, em vez de "sem texto extraível". |
| RF-04 | **Referência no histórico, não o conteúdo inteiro:** a mensagem do usuário vira legenda + `[Anexo #12: relatorio.pdf · PDF · 18 páginas · 42 mil caracteres]` + trecho inicial (~1.500 caracteres). Documentos pequenos (< 6.000 caracteres) entram inteiros. | Must | Um PDF de 40 mil caracteres ocupa ≤ 2.000 no histórico. |
| RF-05 | **Ferramentas do agente:** `listar_anexos(tipo?, busca?, periodo?, limite?)`; `ler_anexo(id, paginas?, inicio?, max_caracteres?)`; `buscar_nos_anexos(termo)` (FTS5 no texto extraído); `analisar_imagem(id, pergunta)` (nova consulta de visão sobre uma imagem já guardada). | Must | "Resuma os PDFs 2 e 3 que mandei hoje" lê só esses dois; "naquela foto do recibo, qual era o CNPJ?" encontra e responde. |
| RF-06 | **Visão direta:** se a mensagem atual tem imagem e o provider de visão (`VISION_PROVIDER`, padrão Gemini) está disponível, a imagem vai junto com o texto no formato multimodal (OpenAI-compat: `content` com `image_url` em data URI). | Must | "O que tem de errado neste print?" é respondido olhando a imagem. |
| RF-07 | **Degradação sem visão:** no fallback para um modelo só de texto (ex.: `qwen2.5:7b` no Ollama), o contexto recebe o **OCR + a descrição em cache** no lugar da imagem, e o agente avisa quando a resposta depender de detalhes visuais. | Must | Com o Gemini fora do ar, perguntas sobre o texto da imagem continuam funcionando. |
| RF-08 | **Motores de OCR (Strategy + fallback, `OCR_ENGINES`):** (1) `ppocr`: **PP-OCRv5** (detecção + reconhecimento Latin) em ONNX, **no próprio processo**, via `onnxruntime-node`, na GPU (DirectML no Windows, CUDA no Linux) com fallback automático para a CPU; modelos baixados uma vez para `OCR_MODELS_DIR`; (2) `gemini`: visão do Gemini com instrução de transcrição fiel, para manuscrito ou layout difícil e quando o `ppocr` tiver baixa confiança; (3) `ocrs`: pdfcraft-cli, **apenas como último recurso**, por não reconhecer acentos. O `servico_paddle_ocr` (PaddleOCR-VL) **não** é usado, por ser lento. | Must | Um recibo em pt-BR é lido com acentos e "ç" corretos pelo `ppocr`; sem GPU disponível, o mesmo OCR roda na CPU e o log registra o dispositivo usado. |
| RF-09 | **Tarefas com vários documentos:** skill `analista-documentos` (map-reduce: resumo por documento → síntese final), com `max_iterations` maior (spec web-search RF-10). | Should | "Compare os 3 contratos e diga as diferenças de prazo" cita o anexo de origem de cada ponto. |
| RF-10 | **Comandos:** `/anexos` (últimos 20, com ID, tipo e data); `/anexo <id>` (detalhes e reenvio do arquivo); `/apagar_anexo <id>`. No terminal: `/imagem <caminho> [pergunta]` e `/anexos`. | Must | O usuário vê e gerencia o que está guardado. |
| RF-11 | **Retenção:** anexos com mais de `ATTACHMENTS_RETENTION_DAYS` (padrão 90) ou acima da cota `ATTACHMENTS_MAX_GB` (padrão 5) são removidos, os mais antigos primeiro. A referência no histórico passa a dizer "anexo expirado". | Must | A pasta nunca passa da cota; nada quebra ao citar um anexo expirado. |
| RF-12 | **Limites de processamento:** OCR de até `OCR_MAX_PAGES` (padrão 50) páginas por documento, com aviso; planilhas com até `SHEET_MAX_ROWS` (padrão 500) linhas por aba no texto extraído, mais o resumo das demais. | Must | Um PDF de 300 páginas escaneadas processa as 50 primeiras e avisa; o restante pode ser pedido por intervalo. |

### 6.2 Fluxo Principal (Happy Path)

**A. Foto de um recibo:** "quanto deu no total?"
1. `TelegramInputHandler` recebe `message:photo` e baixa a maior resolução.
2. `AttachmentStore` salva como anexo #31; `ImageProcessor` roda o OCR (PP-OCRv5, na GPU) e guarda o texto.
3. O `AgentController` monta a entrada: legenda + `[Anexo #31: foto · imagem]` + a imagem em formato multimodal (Gemini).
4. O Gemini lê a imagem e responde com o total. Se o fallback estiver ativo, responde a partir do texto do OCR.

**B. Vários documentos, dias depois:** "pegue os relatórios de setembro e outubro e monte um comparativo"
1. O agente chama `listar_anexos(busca="relatório")` e identifica os anexos #18 e #24.
2. `ler_anexo(18)` e `ler_anexo(24)`; se forem longos, lê por páginas.
3. Entrega o comparativo citando `[Anexo #18, p. 3]`, em texto ou como documento.

### 6.3 Fluxos Alternativos

- **Referência ambígua** ("aquela imagem"): o agente lista os anexos recentes do tipo e assume o mais recente, dizendo qual usou ("usei a foto de ontem, 14:32, anexo #31").
- **Imagem sem texto** (foto de paisagem): o OCR volta vazio e a resposta vem só da visão.
- **Arquivo protegido por senha:** aviso pedindo a versão sem senha; o anexo é guardado sem texto extraído.

---

## 7. Requisitos Não-Funcionais

| ID | Requisito | Valor alvo | Observação |
|----|-----------|-----------|------------|
| RNF-01 | OCR por página A4 (PP-OCRv5, GPU) | < 1 s (meta a validar no protótipo; CPU < 5 s) | Roda fora do loop principal (worker thread) para não bloquear o polling do Telegram. Modelos carregados uma vez e mantidos em memória (~100 MB). |
| RNF-02 | Resposta sobre uma imagem (Gemini) | < 15 s | Imagem redimensionada para no máximo 2.048 px no maior lado antes do envio. |
| RNF-03 | Processamento no recebimento | Assíncrono | O usuário pode continuar conversando; a pergunta sobre o anexo espera o processamento terminar. |
| RNF-04 | Privacidade | OCR local por padrão | A visão via Gemini envia a imagem ao Google (configurável, §12). |

---

## 8. Design e Interface

```
Telegram/Terminal ─► AttachmentIntake (download, álbum, sha256)
                         │
                         ▼
                   AttachmentStore (disco + SQLite + FTS5)
                         │  processa por tipo (Strategy)
        ┌────────────────┼──────────────────┬─────────────────┐
   ImageProcessor   PdfProcessor       OfficeProcessor     TextProcessor
   (OCR + descrição) (texto + OCR/pág)  (docx/xlsx/pptx)
        │                │
        └── IOcrEngine: PP-OCRv5 ONNX (GPU/CPU, no processo) → Gemini → ocrs/pdfcraft
                         │
AgentController ─► referência + trecho no histórico ─► AgentLoop
                                  └── ferramentas: listar_anexos, ler_anexo,
                                      buscar_nos_anexos, analisar_imagem
```

**Mudança no contrato do LLM:** `ChatMessage.content` passa a aceitar partes (`text` | `image`), e os providers declaram `supportsVision`. O `FallbackLlmProvider` só envia imagem para providers com visão; nos demais, troca a imagem pelo texto em cache (RF-07).

---

## 9. Modelo de Dados

```sql
attachments {
  id: integer               -- o "#31" exibido ao usuário
  user_id: string
  conversation_id: string
  kind: string              -- image | pdf | docx | xlsx | pptx | text | other
  original_name: string
  mime: string
  path: string              -- relativo a ATTACHMENTS_DIR
  size_bytes: integer
  sha256: string            -- deduplicação
  caption: text
  pages: integer            -- quando aplicável
  extracted_chars: integer
  status: string            -- pending | ready | failed | expired
  created_at: datetime
}
attachment_texts {           -- texto por página/aba/slide, com origem (camada de texto, ocr:ppocr, ocr:gemini...)
  attachment_id, part_index, part_label, source, text
}
attachments_fts             -- FTS5 sobre attachment_texts.text (RF-05 buscar_nos_anexos)
```

---

## 10. Integrações e Dependências

| Dependência | Tipo | Impacto se indisponível |
|-------------|------|------------------------|
| `onnxruntime-node` + modelos PP-OCRv5 ONNX (detecção + `latin_PP-OCRv5_mobile_rec` + `ppocrv5_latin_dict.txt`) | Obrigatória (OCR padrão) | Fallback para OCR via Gemini. Sem serviço externo nem disputa com o Data Ingest. Licença dos modelos PaddleOCR: Apache-2.0. |
| Gemini (multimodal) | Recomendada (visão) | Sem visão direta: respostas a partir do OCR e da descrição em cache. |
| Modelo de visão local no Ollama (ex.: `qwen2.5vl`) | Opcional | Permite visão 100% local (`VISION_PROVIDER=ollama:<modelo>`). |
| `pdf-parse` v2 (já instalado) | Obrigatória | Texto e renderização de páginas de PDF para OCR. |
| `mammoth` (DOCX), `exceljs` (XLSX), parser de PPTX (ex.: `officeparser`) | Obrigatórias por formato | O formato correspondente fica indisponível, com aviso. |
| `sharp` | Obrigatória | Redimensionar e converter imagens (HEIC/WEBP → JPEG/PNG). |
| pdfcraft-cli (`ocrs`) | Opcional (último recurso) | Sem impacto: só é usado sem os outros motores e não lê acentos. |

**Novas variáveis de ambiente:**

```env
ATTACHMENTS_DIR=./data/attachments
ATTACHMENTS_RETENTION_DAYS=90
ATTACHMENTS_MAX_GB=5
VISION_PROVIDER=gemini                 # gemini | ollama:<modelo-de-visão> | none
OCR_ENGINES=ppocr,gemini               # ordem de preferência (ocrs = último recurso, sem acentos)
OCR_DEVICE=auto                        # auto | gpu | cpu (auto: tenta DirectML/CUDA e cai para CPU)
OCR_MODELS_DIR=./data/models/ocr       # modelos ONNX baixados no primeiro uso
OCR_MAX_PAGES=50
SHEET_MAX_ROWS=500
```

---

## 11. Edge Cases e Tratamento de Erros

| Cenário | Trigger | Comportamento esperado |
|---------|---------|----------------------|
| EC-01: Prompt injection em documento ou imagem | Texto no arquivo manda o bot ignorar instruções ou executar ações | Conteúdo de anexo é sempre **dado** (mesma regra da spec web-search RF-07); ferramentas de escrita só por pedido explícito do usuário. |
| EC-02: Arquivo malicioso ou "zip bomb" | DOCX/XLSX/PPTX são ZIP; arquivo com descompressão gigante | Limite de tamanho descomprimido (ex.: 100 MB) e de número de entradas; macros nunca são executadas. |
| EC-03: GPU indisponível ou sem VRAM | Driver sem DirectML/CUDA ou GPU cheia (Ollama, Kokoro, Chatterbox) | `OCR_DEVICE=auto` cai para a CPU, mais lenta, mas funcional; o log registra o dispositivo. |
| EC-04: Foto muito comprimida | Foto enviada como "foto" (Telegram comprime) com texto pequeno | Se o OCR tiver baixa confiança, sugere reenviar "como arquivo" para manter a qualidade. |
| EC-05: Planilha enorme | Milhares de linhas ou várias abas | Resumo de colunas e estatísticas + primeiras `SHEET_MAX_ROWS` linhas; leitura por intervalo via `ler_anexo`. |
| EC-06: Anexo expirado ou apagado | Usuário cita o anexo #5 já removido | "O anexo #5 expirou em 12/09; reenvie se precisar." |
| EC-07: Mesmo arquivo reenviado | sha256 igual | Reaproveita o anexo e o texto já extraído (sem novo OCR). |
| EC-08: PDF com senha / Office protegido | Abertura falha | Guarda o arquivo, marca `failed` e pede a versão sem senha. |

---

## 12. Segurança e Privacidade

- **Armazenamento local:** anexos ficam em `data/` (fora do Git), isolados por usuário; `ler_anexo` só acessa anexos do próprio usuário.
- **Visão na nuvem:** com `VISION_PROVIDER=gemini`, as imagens e páginas enviadas para análise visual saem para o Google. Para documentos sensíveis: `VISION_PROVIDER=ollama:<modelo>` ou `none` (só OCR local).
- **Controle do usuário:** `/anexos` e `/apagar_anexo` (RF-10); a retenção (RF-11) limita o tempo de guarda.
- **Sem execução:** nenhum conteúdo de anexo é executado (macros, scripts, links).

---

## 13. Plano de Rollout

1. **Biblioteca de anexos** (RF-02, RF-04, RF-05, RF-10, RF-11) para os formatos atuais (PDF e MD). Resolve na hora o "voltar a um documento" e o histórico inchado.
2. **Protótipo de OCR (antes de implementar):** medir o PP-OCRv5 Latin em imagens e PDFs reais em pt-BR (acurácia com acentos, tempo por página na GPU via DirectML e na CPU) e compará-lo com o `ocrs` do pdfcraft. Só segue se atingir o RNF-01 e a métrica de erro da seção 3.
3. **Imagens:** recebimento e álbuns (RF-01), visão via Gemini (RF-06) e OCR PP-OCRv5 (RF-08), com a degradação do RF-07.
4. **Formatos Office** (RF-03: DOCX, XLSX, PPTX, CSV).
5. **PDF escaneado** com OCR por página (RF-03, RF-12).
6. **Skill `analista-documentos`** (RF-09).

**Impacto em outras specs (atualizar após aprovação):**
- `telegram-input.md`: remover o NG-01 (imagens) e ampliar o RF-02 (novos formatos e biblioteca de anexos).
- `memory.md` v1.1: a seção `Anexos citados` do resumo passa a usar os IDs desta spec.
- `agent-loop.md`: novas ferramentas e mensagens multimodais.
- `architecture.md` §2.6: PP-OCRv5 (ONNX, `onnxruntime-node`), `mammoth`, `exceljs`, `sharp` e visão no Gemini.

---

## 14. Open Questions

- OQ-01: Se o protótipo mostrar que o PP-OCRv5 erra em layouts complexos (tabelas, colunas), vale ter um modo "documento difícil" que manda a página ao Gemini, em vez de um OCR local mais pesado?
- OQ-02: A visão via Gemini pode ser usada em **todas** as imagens, ou só quando o usuário pedir explicitamente, deixando o padrão só com OCR local?
- OQ-03: Prazo de retenção: 90 dias e 5 GB atendem, ou prefere guardar para sempre e apagar só manualmente?
