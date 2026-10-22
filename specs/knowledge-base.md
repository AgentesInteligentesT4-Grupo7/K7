# Spec: Base de Conhecimento (RAG) por fita

**Versão:** 1.0
**Status:** Implementada (v1.0): busca híbrida + RRF, RAG-Fusion, HyDE, Adaptive e CRAG; GraphRAG fica para depois
**Autor:** ParreiraClaw Agent
**Data:** 2026-10-22
**Reviewers:** Parreira

---

## 1. Resumo

O módulo `conhecimento` dá a cada fita uma base de documentos própria (políticas de uma loja, manual de um
produto, bíblia de uma história, anotações do usuário). O agente busca nela antes de responder e cita os
trechos. A busca combina palavras (FTS5) e significado (vetores), e técnicas avançadas podem ser ligadas
por fita no `perfil.yaml`.

## 2. Goals

- G-01: fita sem código: documentos são dados (`.md`, `.txt`, `.pdf`) numa pasta.
- G-02: funciona sem GPU e sem chave (busca por palavras); melhora sozinha com embeddings.
- G-03: embeddings locais (Ollama na GPU) ou na nuvem (Gemini), escolhidos automaticamente.
- G-04: resposta fundamentada: trechos numerados, citação [n], "não encontrei" em vez de inventar.

## 3. Non-Goals

- GraphRAG (exigiria Neo4j e extração de entidades).
- Reranker local dedicado (o avaliador CRAG cumpre parte do papel).
- Baixar modelos automaticamente: o log mostra o comando (`ollama pull embeddinggemma`).

## 4. Pastas e bases

| Raiz | Onde | Rótulo |
|---|---|---|
| Fita | `<fita>/conhecimento/` (sem perfil: `./conhecimento`) | `fita:` |
| Usuário | `<dados do perfil>/conhecimento/` (o que `guardar_no_conhecimento` grava) | `usuario:` |

- Cada subpasta é uma base; arquivos soltos na raiz vão para a base `geral`.
- `bases.yaml` (registro): `nome: { descricao, idioma }` ou `nome: "descrição"`. A descrição aparece na
  descrição da ferramenta, para o LLM escolher a base certa.

## 5. Design

### 5.1 Indexação (`KnowledgeIndexer`)

- Varre as raízes no startup (em segundo plano) e antes de cada busca se passaram 30 s; reprocessa só
  arquivos novos ou com tamanho/mtime diferente e remove os apagados.
- Fatiamento por parágrafo (alvo 900 caracteres, sobreposição 150; frases quando o parágrafo é maior).

### 5.2 Armazenamento (`KnowledgeStore`, banco do perfil)

`kb_documents(key, base, mtime_ms, size, chunks)`, `kb_chunks(doc_id, base, ord, text, embedding, embed_model)`
e `kb_fts` (FTS5, `unicode61 remove_diacritics 2`). Vetores em BLOB Float32; busca por cosseno em memória.

### 5.3 Embeddings

| `EMBEDDINGS_PROVIDER` | Comportamento |
|---|---|
| `auto` (padrão) | Ollama se houver GPU NVIDIA e o modelo estiver baixado → Gemini (chave + privacidade `publico`) → nenhum |
| `ollama` / `gemini` | Só aquele |
| `off` | Só palavras |

- Ollama: `/api/embed`, modelo `OLLAMA_EMBED_MODEL` (padrão `embeddinggemma`, multilíngue).
- Gemini: `batchEmbedContents`, `gemini-embedding-001`, 768 dimensões, `RETRIEVAL_DOCUMENT`/`RETRIEVAL_QUERY`,
  chave no cabeçalho. Lotes de 100; cota esgotada pausa os vetores por 10 min e a busca segue por palavras.
- Trocar de provedor reprocessa os vetores (cada trecho guarda o modelo que o gerou).

### 5.4 Recuperação (`KnowledgeRetriever`)

1. **Planejador** (1 pedido ao LLM de roteamento, só se alguma técnica estiver ligada): JSON com `rota`
   (Adaptive: direta/simples/complexa), `variacoes` (RAG-Fusion), `subperguntas` (rota complexa) e `hipotese` (HyDE).
2. **Busca:** cada consulta (original + variações + sub-perguntas) no FTS5; com vetores, cada consulta e a
   hipótese na busca vetorial (20 candidatos por lista).
3. **Fusão:** Reciprocal Rank Fusion (k = 60).
4. **CRAG** (1 pedido): notas 0–1 por trecho. ≥ 0,7 = correto (fica com os trechos ≥ 0,5); < 0,3 = incorreto
   (descarta e usa a internet); entre = ambíguo (trechos ≥ 0,5 + internet). A internet vem do `pesquisar_web`.

### 5.5 Entrega

- Ferramenta `consultar_conhecimento`: trechos numerados dentro de `<conteudo_externo>`, com arquivo, base e
  número do trecho, mais a instrução de citar [n] ou dizer que não encontrou.
- Modo `automatico`: o controlador recupera para toda mensagem (rota "direta" pula) e põe os trechos no
  system prompt (`# Conhecimento da fita`).
- O system prompt manda consultar a base antes da memória e da internet; a skill `pesquisador-web` também.

## 6. Requisitos funcionais

| ID | Requisito |
|---|---|
| RF-01 | Bases por subpasta + `bases.yaml`; `.md`, `.markdown`, `.txt`, `.pdf` até 30 MB |
| RF-02 | Reindexação incremental e remoção de apagados |
| RF-03 | Busca lexical sem acento e com prefixo (plurais) para termos de 4+ letras, sem palavras vazias |
| RF-04 | Busca vetorial opcional e fusão RRF |
| RF-05 | RAG-Fusion, HyDE, Adaptive e CRAG por fita (`modulos.conhecimento`) ou `.env` (`CONHECIMENTO_*`) |
| RF-06 | `guardar_no_conhecimento` grava `.md` nos dados do perfil (texto ou anexo) e indexa na hora |
| RF-07 | Regras no system prompt: base antes da internet, citar [n], admitir lacunas |
| RF-08 | Gemini nunca recebe documentos de fita com privacidade `pessoal` ou `local` |

## 7. Edge cases

| Cenário | Comportamento |
|---|---|
| Pasta vazia | Ferramentas existem; "base vazia" com instrução de onde pôr arquivos |
| PDF escaneado sem texto | Indexa vazio (OCR é do módulo anexos) |
| Ollama sem o modelo | Aviso com o comando `ollama pull` e cai para o Gemini/palavras |
| Cota do Gemini esgotada | Pausa 10 min; trechos sem vetor continuam na busca por palavras |
| Base inexistente na ferramenta | Erro com a lista de bases |
| Planejador/avaliador fora do ar | Segue sem a técnica (busca simples) |
