# Spec: Debate entre agentes com o usuário no meio

**Versão:** 1.0
**Status:** Implementada (v1.0), módulo `refinamento`
**Autor:** ParreiraClaw Agent
**Data:** 2026-10-22
**Reviewers:** Parreira

---

## 1. Resumo

A ferramenta `debate` põe de 2 a 5 agentes com perspectivas diferentes para discutir um tema em rodadas.
Em cada rodada, cada agente lê as posições dos outros, reflete e atualiza a sua; um juiz dá notas
(fundamentação, viabilidade, originalidade) e o debate **pausa** para o usuário decidir: manter ou descartar
agentes, trazer uma ideia própria (vira um novo agente), pedir a combinação das duas melhores posições
(cruzamento + variação, à moda de um algoritmo genético), dar uma orientação geral, outra rodada ou encerrar
(síntese do moderador).

## 2. Design

- **Estado** em `debates(user_id, state, updated_at)` no banco do perfil: um debate por usuário, que
  atravessa mensagens e reinícios.
- **Participantes:** gerados pelo LLM (perspectivas realmente diferentes), dados pelo usuário
  (`perspectivas: "Engenheira: custo; Designer: usuário"`) ou personas da fita (`personas: "kael, mira"`).
- **Custo por rodada:** 1 pedido por agente ativo + 1 do juiz (+1 para gerar perspectivas no início, +1 para
  combinar, +1 para encerrar). Máximo de 6 agentes ativos.
- **Continuidade:** enquanto houver debate mexido nas últimas 2 h, o controlador (a) põe um lembrete
  `# Debate em andamento` no system prompt e (b) não deixa o roteador trocar de skill, para o retorno do
  usuário ("descarta o 3 e combina") virar `debate(acao=continuar, ...)`.

## 3. Requisitos

| ID | Requisito |
|---|---|
| RF-01 | `acao`: iniciar, continuar, estado, encerrar |
| RF-02 | Descartados não participam nem aparecem para os outros; aparecem em "Fora do debate" |
| RF-03 | Tabela de notas ordenada pelo total |
| RF-04 | Falha de um pedido mantém a posição anterior (nunca derruba o debate) |
| RF-05 | Tema e posições são dados para os agentes (não instruções) |
