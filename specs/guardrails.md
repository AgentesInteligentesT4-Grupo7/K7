# Spec: Guardrails declarativos por fita

**Versão:** 1.0
**Status:** Implementada (v1.0): heurística de injeção, verificador LLM opcional, dados pessoais, palavras proibidas, tópicos e abstenção
**Autor:** ParreiraClaw Agent
**Data:** 2026-10-22
**Reviewers:** Parreira

---

## 1. Resumo

Cada fita declara no `perfil.yaml` os limites do seu agente: o que bloquear na entrada (prompt injection,
assunto fora do escopo), como tratar conteúdo externo (páginas, anexos, APIs) e o que limpar na saída
(palavras proibidas, dados pessoais e segredos). Os limites não exigem código na fita: são dados, como o resto do perfil.

Base: os conceitos de *guardrails* de entrada/saída e de ações em caso de falha (exceção, correção, nova tentativa),
detecção de injeção com um avaliador que devolve JSON, mascaramento de PII, lista de palavras com normalização
contra ofuscação, restrição de tópico e abstenção (responder "não sei" em vez de inventar).

## 2. Goals

- G-01: fita pública (ex.: promo) não vaza CPF, telefone, e-mail ou chave de API na resposta.
- G-02: fita temática (ex.: receitas) não sai do assunto, mesmo se o usuário insistir.
- G-03: texto de página/anexo que tenta dar ordens ao agente chega ao LLM marcado como dado.
- G-04: tudo opcional e barato: sem configuração, só a marcação de conteúdo externo (regex) fica ligada.

## 3. Non-Goals

- Classificador local de toxicidade (exigiria baixar modelo).
- Validação de saída estruturada por schema (fica para quando uma skill precisar).

## 4. Configuração (`perfil.yaml`)

```yaml
guardrails:
  injecao: bloquear            # off | avisar (padrão) | bloquear — mensagem do usuário
  verificar_com_llm: true      # confirma a heurística e checa o tópico com o LLM de roteamento (1 pedido)
  dados_pessoais: mascarar     # off (padrão) | mascarar | bloquear — resposta
  proibidas:                   # ou só a lista: proibidas: [a, b]
    palavras: [concorrente x, palavrão]
    acao: refazer              # corrigir (mascara, padrão) | refazer (LLM reescreve) | bloquear
  topicos:
    permitidos: [culinária, receitas]
    proibidos: [política]
    acao: bloquear             # bloquear (padrão) | avisar
  abster: [saude, juridico, financeiro]   # áreas com resposta só geral + "procure um profissional"
```

O carregador valida o bloco (erro acionável no startup) e o repassa ao Config como `GUARDRAILS` (JSON).
Sem perfil, `GUARDRAILS` pode ser definido no `.env` em JSON com as mesmas chaves.

## 5. Requisitos funcionais

| ID | Requisito |
|---|---|
| RF-01 | **Injeção (heurística):** padrões pt/en (ignorar instruções, troca de papel, vazar o prompt, jailbreak, marcadores de sistema, exfiltração de segredo), sobre texto sem acento. |
| RF-02 | **Dados pessoais:** CPF e CNPJ com dígito verificador, e-mail, telefone BR com DDD/separador, cartão com Luhn, chaves (OpenAI, Google, GitHub, Slack, token de bot do Telegram). O log registra só os tipos, nunca os valores. |
| RF-03 | **Palavras proibidas:** regex por palavra que aceita acento, leetspeak (4→a, 3→e, 0→o…), letras repetidas e separadores entre letras (`p.a.l.a.v.r.a`); não casa dentro de outra palavra. |
| RF-04 | **Entrada:** com `injecao: bloquear`, a mensagem suspeita é respondida com recusa sem chamar o LLM principal (as duas mensagens ficam no histórico). Com `avisar`, o system prompt ganha um "Aviso de segurança". Documento enviado pelo usuário é conteúdo externo: só aviso. |
| RF-05 | **Verificador LLM:** com `verificar_com_llm`, um único pedido ao LLM de roteamento devolve `{seguro, permitido, motivo}`. Se o LLM disser que é seguro, a heurística é descartada (falso positivo). Falha do verificador = segue só a heurística. |
| RF-06 | **Tópicos:** `permitidos`/`proibidos` entram como regra no system prompt; com o verificador, a entrada fora do tópico é recusada (`bloquear`) ou só avisada. |
| RF-07 | **Abstenção:** áreas de `abster` viram regra no prompt (informação geral, nunca diagnóstico/prescrição, indicar profissional, dizer "não sei" na dúvida). |
| RF-08 | **Conteúdo externo:** toda observação de ferramenta com cara de injeção ganha um prefixo `[guardrail: …]` antes de chegar ao LLM (independe do `injecao`, exceto `off`). |
| RF-09 | **Saída:** palavras proibidas (corrigir/refazer/bloquear; "refazer" que não resolveu cai para máscara), depois dados pessoais (mascarar/bloquear). A versão salva na memória é a já limpa. |
| RF-10 | Eventos (`injecao: …`, `topico: …`, `proibidas: …`, `dados_pessoais: cpf`) vão no metadata da mensagem (`guardrails`). |

## 6. Edge cases

| Cenário | Comportamento |
|---|---|
| "Esqueça as instruções anteriores da receita" | Heurística marca; com verificador, o LLM libera; sem verificador e `bloquear`, recusa (use `avisar` em fitas conversacionais) |
| PDF do usuário com "ignore all previous instructions" | Só aviso; o resumo é feito |
| Número de pedido de 8 dígitos | Não é telefone (exige DDD ou separador e ≥ 10 dígitos) |
| CPF com dígito errado | Não é mascarado |
| YAML `injecao: off` (lido como `false`) | Tratado como `off` |
